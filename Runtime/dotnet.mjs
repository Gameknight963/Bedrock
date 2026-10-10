const contexts = new Map();
const assemblies = new Map();
let runtimePromise;
function context(id) {
    const value = contexts.get(id);
    if (!value || value.signal.aborted) throw new Error('Plugin context has stopped');
    return value;
}
async function sharedRuntime() {
    if (!runtimePromise) runtimePromise = (async () => {
        const { dotnet } = await import('bedrock://managed/_framework/dotnet.js');
        const runtime = await dotnet.withDiagnosticTracing(false).create();
        runtime.setModuleImports('bedrock', {
            getSetting: (id, key, fallback) => JSON.stringify(context(id).settings.get(key, JSON.parse(fallback))),
            setSetting: async (id, key, json) => { await context(id).settings.set(key, JSON.parse(json)); },
            log: (id, level, message) => contexts.get(id)?.log[level](message),
            reportStatus: (id, message) => context(id).reportStatus(message),
            requireRestart: (id, reason) => context(id).requireRestart(reason),
            addStyle: (id, css) => context(id).styles.add(css),
            subscribe: (id, name, callback) => context(id).events.on(name, value => callback(JSON.stringify(value))),
            emit: async (id, name, json) => { await context(id).events.emit(name, JSON.parse(json)); },
            moduleUrl: (id, path) => {
                const root = new URL(`bedrock://plugins/${encodeURIComponent(id)}/`);
                const result = new URL(path, root);
                if (result.protocol !== root.protocol || result.hostname !== root.hostname || !result.pathname.startsWith(root.pathname)) throw new Error('Module path must stay inside the plugin folder');
                return result.href;
            }
        });
        return { runtime, host: (await runtime.getAssemblyExports('Bedrock.Host')).Host };
    })();
    return runtimePromise;
}
export async function loadPlugin(info) {
    const { host } = await sharedRuntime();
    const response = await fetch(info.renderer);
    if (!response.ok) throw new Error('Could not read the managed plugin assembly');
    const assembly = host.Load(info.manifest.id, new Uint8Array(await response.arrayBuffer()));
    assemblies.set(info.manifest.id, assembly);
    const id = info.manifest.id;
    return {
        async start(ctx) {
            contexts.set(id, ctx);
            ctx.cleanup(() => host.Cancel(id));
            try {
                const definitions = JSON.parse(host.Prepare(id));
                await globalThis.BedrockNative.request('settingsDefine', id, definitions);
                ctx.signal.throwIfAborted();
                await host.Start(id);
            } catch (error) {
                try { await host.Stop(id); } catch (stopError) { ctx.log.error(stopError); }
                contexts.delete(id);
                throw error;
            }
        },
        async stop() {
            try { await host.Stop(id); } finally { contexts.delete(id); }
        }
    };
}

export async function getPluginExports(id) {
    const assembly = assemblies.get(id);
    if (!assembly) throw new Error('Managed plugin assembly has not loaded');
    const { runtime } = await sharedRuntime();
    return runtime.getAssemblyExports(assembly);
}
