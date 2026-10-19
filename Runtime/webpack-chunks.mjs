const identifier = '[A-Za-z_$][\\w$]*';
const id = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|\\d+)';
const chunkCall = `${identifier}\\.e\\(\\s*${id}\\s*\\)`;
const defaultMatch = new RegExp(`(?:Promise\\.all\\(\\[\\s*(${chunkCall}(?:\\s*,\\s*${chunkCall})*)\\s*\\]\\)|(${chunkCall})|Promise\\.resolve\\(\\))\\.then\\(${identifier}\\.bind\\(${identifier},\\s*(${id})\\s*\\)\\)`);

function parseId(value) {
    const text = value?.trim();
    if (!text || !new RegExp(`^${id}$`).test(text)) throw new Error('Chunk matcher returned an invalid module or chunk ID');
    return /^\d+$/.test(text) ? String(Number(text)) : text.slice(1, -1);
}

export function createChunkLoader({ original = factory => factory } = {}) {
    const runtimes = new Set(), waiters = new Set();
    return {
        register(runtime) {
            runtimes.add(runtime);
            for (const resolve of [...waiters]) resolve();
        },
        async load({ find, match } = {}, signal) {
            const fragments = typeof find === 'string' ? [find] : find;
            if (!Array.isArray(fragments) || !fragments.length || fragments.some(value => typeof value !== 'string' || !value.length))
                throw new TypeError('loadChunks.find must be a nonempty string or array of nonempty strings');
            if (match !== undefined && !(match instanceof RegExp)) throw new TypeError('loadChunks.match must be a regular expression');
            signal.throwIfAborted();
            let abort;
            const stopped = new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            });
            stopped.catch(() => {});
            let ready;
            try {
                if (!runtimes.size) await Promise.race([stopped, new Promise(resolve => { ready = resolve; waiters.add(resolve); })]);
                signal.throwIfAborted();
                const found = [];
                for (const runtime of runtimes) for (const [moduleId, factory] of Object.entries(runtime.m || {})) {
                    if (typeof factory !== 'function') continue;
                    const source = Function.prototype.toString.call(original(factory));
                    if (fragments.every(fragment => source.includes(fragment))) found.push({ runtime, moduleId, source });
                }
                if (!found.length) throw new Error(`No Discord module contains the chunk-loading marker: ${fragments.join(', ')}`);
                if (found.length !== 1) throw new Error(`Chunk-loading marker matches ${found.length} Discord modules; use a more specific find value`);
                const { runtime, moduleId, source } = found[0];
                const result = new RegExp((match || defaultMatch).source, (match || defaultMatch).flags.replace(/[gy]/g, '')).exec(source);
                if (!result) throw new Error(`No recognized chunk-loading instruction in Discord module ${moduleId}`);
                const chunks = match ? result[1] : result[1] || result[2];
                const entry = parseId(match ? result[2] : result[3]);
                const ids = [];
                if (chunks) {
                    if (!new RegExp(`^\\s*${chunkCall}(?:\\s*,\\s*${chunkCall})*\\s*,?\\s*$`).test(chunks))
                        throw new Error('Chunk matcher must capture chunk-loading calls in group 1 and the entry module ID in group 2');
                    const calls = new RegExp(`${identifier}\\.e\\(\\s*(${id})\\s*\\)`, 'g');
                    for (const call of chunks.matchAll(calls)) ids.push(parseId(call[1]));
                }
                if (ids.length && typeof runtime.e !== 'function') throw new Error('Discord chunk loader is unavailable');
                try { await Promise.race([stopped, Promise.all([...new Set(ids)].map(id => runtime.e(id)))]); }
                catch (error) {
                    signal.throwIfAborted();
                    throw new Error(`Could not load chunks for Discord module ${moduleId}: ${error.message}`, { cause: error });
                }
                signal.throwIfAborted();
                if (typeof runtime.m[entry] !== 'function') throw new Error(`Loaded chunks did not provide Discord entry module ${entry}`);
                try { runtime(entry); }
                catch (error) { throw new Error(`Discord entry module ${entry} failed: ${error.message}`, { cause: error }); }
            } finally {
                signal.removeEventListener('abort', abort);
                if (ready) waiters.delete(ready);
            }
        }
    };
}
