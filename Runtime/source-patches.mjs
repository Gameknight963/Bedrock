function compile(source) {
    try { return new Function(`return (${source})`)(); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return Object.values(new Function(`return ({${source}})`)())[0];
    }
}

export function createSourcePatches({ report = () => {}, restart = () => {} } = {}) {
    const plugins = new Map();
    const executed = new Map();
    const matches = (patch, source) => source.includes(patch.find);
    const reason = 'Restart Discord to apply changes to source patches.';
    const publish = plugin => report(plugin.id, plugin.patches.map(patch => ({
        id: patch.id, find: patch.find, state: patch.state, modules: [...patch.modules], error: patch.error
    })));
    return {
        register(id, namespace) {
            const previous = plugins.get(id);
            if (previous?.namespace === namespace) { previous.active = true; previous.disableRequested = false; return; }
            const definitions = namespace.patches ?? [];
            if (!Array.isArray(definitions)) throw new Error('Exported patches must be an array.');
            const patches = definitions.map((definition, index) => {
                if (!definition || typeof definition.find !== 'string' || !definition.find)
                    throw new Error(`Source patch ${index + 1} needs a nonempty find string.`);
                const replacements = Array.isArray(definition.replacement) ? definition.replacement : [definition.replacement];
                if (!replacements.length || replacements.some(replacement => !replacement ||
                    !(typeof replacement.match === 'string' || replacement.match instanceof RegExp) ||
                    !['string', 'function'].includes(typeof replacement.replace)))
                    throw new Error(`Source patch ${index + 1} needs valid match and replace values.`);
                return { ...definition, replacements, id: definition.id || `patch-${index + 1}`,
                    state: 'waiting', modules: new Set(), error: null };
            });
            const plugin = { id, namespace, patches, active: true };
            plugins.set(id, plugin);
            for (const patch of patches) for (const [factory, moduleId] of executed) {
                if (!matches(patch, Function.prototype.toString.call(factory))) continue;
                patch.state = 'restart-required';
                patch.modules.add(String(moduleId));
                restart(id, reason);
            }
            publish(plugin);
        },
        executed(moduleId, factory) { executed.set(factory, moduleId); },
        apply(moduleId, original) {
            let factory = original;
            let source = Function.prototype.toString.call(original);
            for (const plugin of plugins.values()) {
                if (!plugin.active) continue;
                for (const patch of plugin.patches) {
                    if ((!patch.all && patch.modules.size) || !matches(patch, source)) continue;
                    let candidate = source;
                    try {
                        for (const replacement of patch.replacements) {
                            const match = replacement.match instanceof RegExp
                                ? new RegExp(replacement.match.source, replacement.match.flags) : replacement.match;
                            const found = typeof match === 'string' ? candidate.includes(match) : match.test(candidate);
                            if (!found) throw new Error('Replacement did not match.');
                            if (match instanceof RegExp) match.lastIndex = 0;
                            candidate = candidate.replace(match, replacement.replace);
                        }
                        candidate = candidate.replaceAll('$self', `globalThis.Bedrock._sourcePlugin(${JSON.stringify(plugin.id)})`);
                        const compiled = compile(candidate);
                        if (typeof compiled !== 'function') throw new Error('Replacement is not a module factory.');
                        source = candidate; factory = compiled;
                        patch.state = 'applied'; patch.applied = true; patch.modules.add(String(moduleId));
                    } catch (error) {
                        patch.state = 'failed'; patch.modules.add(String(moduleId));
                        patch.error = `${plugin.id}, ${patch.id}, module ${moduleId}: ${error.message}`;
                    }
                    publish(plugin);
                }
            }
            executed.set(original, moduleId);
            return factory;
        },
        holdsActivation(id) { return plugins.get(id)?.patches.some(patch => patch.applied) || false; },
        forget(id) {
            const plugin = plugins.get(id);
            if (!plugin?.patches.some(patch => patch.applied)) plugins.delete(id);
        },
        disable(id) {
            const plugin = plugins.get(id);
            if (!plugin) return false;
            const needsRestart = plugin.patches.some(patch => patch.applied || patch.state === 'restart-required');
            // Executed patches can still call plugin helpers, including from lazy modules.
            plugin.active = plugin.patches.some(patch => patch.applied);
            if (needsRestart && !plugin.disableRequested) restart(id, reason);
            plugin.disableRequested = true;
            return needsRestart;
        },
        namespace(id) { return plugins.get(id)?.namespace; }
    };
}
