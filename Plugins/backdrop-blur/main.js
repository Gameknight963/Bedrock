import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const { definePluginSettings, OptionType } = Bedrock;
let current;

export const settings = definePluginSettings({
    allowGpuInjection: {
        type: OptionType.BOOLEAN,
        label: 'Enable native GPU hook',
        description: 'Disables Chromium’s GPU sandbox to allow the experimental DLL to load. Requires a restart when enabling.',
        default: false,
        restartNeeded: true
    }
});

export function start(ctx) {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        ctx.log.warn('The native blur experiment currently supports Windows x64 only.');
        return;
    }
    const { app } = require('electron');
    const controller = fileURLToPath(new URL('./native/win32-x64/blur-controller.exe', import.meta.url));
    const state = { stopped: false, pending: Promise.resolve(), busy: false, attempted: new Map(), logged: new Set() };
    current = state;
    let ownsSwitch = false;
    if (settings.store.allowGpuInjection && !app.isReady() && !app.commandLine.hasSwitch('disable-gpu-sandbox')) {
        app.commandLine.appendSwitch('disable-gpu-sandbox');
        ownsSwitch = true;
    }
    const update = () => {
        if (state.stopped || state.busy || !app.isReady()) return;
        if (settings.store.allowGpuInjection && !app.commandLine.hasSwitch('disable-gpu-sandbox')) {
            ctx.requireRestart('Restart Discord to enable the native GPU hook.');
            return;
        }
        const metrics = app.getAppMetrics().filter(metric => metric.type === 'GPU');
        const live = new Map(metrics.map(metric => [metric.pid, metric.creationTime]));
        for (const [pid, time] of state.attempted) if (live.get(pid) !== time) state.attempted.delete(pid);
        const restore = !settings.store.allowGpuInjection;
        const targets = restore ? metrics.filter(metric => state.attempted.has(metric.pid)) :
            metrics.filter(metric => state.attempted.get(metric.pid) !== metric.creationTime);
        if (!targets.length) return;
        state.busy = true;
        state.pending = (async () => {
            for (const metric of targets) {
                if (state.stopped) break;
                if (!restore) state.attempted.set(metric.pid, metric.creationTime);
                try {
                    const args = ['--pid', String(metric.pid)];
                    if (restore) args.push('--restore');
                    await run(controller, args, { windowsHide: true, maxBuffer: 8192 });
                    if (restore) state.attempted.delete(metric.pid);
                    ctx.log.info(restore ? 'Restored original backdrop compositing.' : `Native blur hook installed in GPU process ${metric.pid}.`);
                    if (!restore) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        if (!state.stopped) {
                            const result = await run(controller, ['--pid', String(metric.pid), '--status'], { windowsHide: true, maxBuffer: 8192 });
                            ctx.log.info(`Native blur counters: ${result.stdout.trim()}`);
                        }
                    }
                } catch (error) {
                    const message = error.stderr?.trim() || error.message;
                    if (!state.logged.has(message)) { state.logged.add(message); ctx.log.error(message); }
                }
            }
        })().finally(() => { state.busy = false; });
    };
    const timer = setInterval(update, 1000);
    timer.unref();
    ctx.cleanup(settings.subscribe(update));
    ctx.cleanup(() => {
        state.stopped = true;
        clearInterval(timer);
        if (ownsSwitch) {
            app.commandLine.removeSwitch('disable-gpu-sandbox');
            ctx.requireRestart('Restart Discord to restore the GPU sandbox.');
        }
    });
    state.restore = async () => {
        await state.pending;
        if (!app.isReady()) return;
        const live = new Map(app.getAppMetrics().filter(metric => metric.type === 'GPU').map(metric => [metric.pid, metric.creationTime]));
        for (const [pid, time] of state.attempted) {
            if (live.get(pid) !== time) continue;
            try { await run(controller, ['--pid', String(pid), '--restore'], { windowsHide: true, maxBuffer: 8192 }); }
            catch (error) { ctx.log.error(error.stderr?.trim() || error.message); }
        }
        state.attempted.clear();
    };
    update();
}

export async function stop() {
    const state = current;
    current = undefined;
    if (state) await state.restore();
}
