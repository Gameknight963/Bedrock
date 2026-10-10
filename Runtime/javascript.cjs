// This factory also runs in the renderer page, without Node globals.
function createJsSession(requireModule, seed = '0') {
    const references = new Map(), errors = new WeakMap();
    function fault(code, message) {
        const error = new Error(message); errors.set(error, code); return error;
    }
    let sequence = BigInt(seed), closed = false;
    const hex = text => Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, '0')).join('');
    function decodeText(text) {
        if (typeof text !== 'string' || text.length % 2 || !/^[0-9a-f]*$/i.test(text)) throw new TypeError('Invalid UTF-8 byte encoding.');
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text.match(/../g) || [], byte => parseInt(byte, 16)));
    }
    function decode(value) {
        switch (value.type) {
            case 0: return undefined;
            case 1: return null;
            case 2: if (typeof value.value === 'boolean') return value.value; break;
            case 3: {
                if (typeof value.value === 'number') return value.value;
                if (['NaN', 'Infinity', '-Infinity', '-0'].includes(value.value)) return Number(value.value);
                break;
            }
            case 4: return decodeText(value.value);
            case 5: {
                const decimal = decodeText(value.value);
                if (!/^-?[0-9]+$/.test(decimal)) throw new TypeError('BigInt arguments must be decimal integers.');
                return BigInt(decimal);
            }
            case 6:
                if (!references.has(value.value)) {
                    throw fault(3, 'The JavaScript handle has been released or belongs to another context.');
                }
                return references.get(value.value);
        }
        throw new TypeError('Invalid JavaScript argument.');
    }
    function encode(value) {
        if (value === undefined) return { type: 0 };
        if (value === null) return { type: 1 };
        if (typeof value === 'boolean') return { type: 2, value };
        if (typeof value === 'number') return { type: 3, value: Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value) };
        if (typeof value === 'string') return { type: 4, value: hex(value) };
        if (typeof value === 'bigint') return { type: 5, value: hex(String(value)) };
        if (sequence >= 0xffffffffffffffffn) throw new Error('JavaScript handle space exhausted.');
        const handle = String(++sequence);
        references.set(handle, value);
        return { type: 6, value: handle };
    }
    return {
        // Decode immediately to pin argument objects before a subsequent release.
        prepare(body, arguments_) {
            if (closed) throw fault(6, 'The JavaScript context is stopped.');
            if (typeof body !== 'string' || !Array.isArray(arguments_)) throw fault(4, 'Expected a function body and argument array.');
            let args;
            try { args = arguments_.map(decode); }
            catch (error) { if (errors.has(error)) throw error; throw fault(4, 'Invalid JavaScript argument.'); }
            return () => {
                if (closed) throw fault(6, 'The JavaScript context is stopped.');
                return encode(new Function('args', 'require', body)(args, requireModule));
            };
        },
        release(handle) { return references.delete(handle); },
        close() { closed = true; references.clear(); },
        error(error) {
            let message;
            try { message = String(error?.stack || error); } catch { message = 'JavaScript threw an unreadable value.'; }
            return { code: errors.get(error) || 1, message: message.replaceAll('\0', '\\0').slice(0, 8192) };
        }
    };
}

function createJsTransport(environment, target, options) {
    const pending = new Map();
    // A new identity on re-enable prevents an old renderer result from entering a new context.
    const identity = require('node:crypto').randomUUID();
    const seed = String(BigInt('0x' + identity.replaceAll('-', '').slice(0, 16)));
    const session = environment === 'main' ? createJsSession(require, seed) : null;
    let stopped = false;
    async function renderer(op, message) {
        if (!options.nativeJavaScript) throw Object.assign(new Error('The renderer JavaScript bridge is unavailable.'), { bedrockJsCode: 5 });
        return options.nativeJavaScript(target, identity, op, message);
    }
    return {
        execute(message, reply) {
            if (stopped) { reply({ code: 6, message: 'The JavaScript context is stopped.' }); return; }
            const request = { cancelled: false };
            pending.set(message.id, request);
            let execute;
            try { if (session) execute = session.prepare(message.body, message.arguments); }
            catch (error) { pending.delete(message.id); reply(session.error(error)); return; }
            const prepared = session ? Promise.resolve() : renderer('prepare', message);
            prepared.then(preparation => {
                if (preparation?.code) {
                    pending.delete(message.id);
                    if (!request.cancelled && !stopped) reply(preparation);
                    return;
                }
                if (request.cancelled || stopped) return;
                request.timer = setImmediate(async () => {
                    if (request.cancelled || stopped) return;
                    let result;
                    try { result = session ? { code: 0, value: execute() } : await renderer('execute', message); }
                    catch (error) { result = session ? session.error(error) : { code: error.bedrockJsCode || 7, message: String(error.message || error) }; }
                    pending.delete(message.id);
                    if (request.cancelled || stopped) {
                        if (result.value?.type === 6) this.release(result.value.value);
                    } else reply(result);
                });
            }).catch(error => {
                pending.delete(message.id);
                if (!request.cancelled && !stopped) reply({ code: error.bedrockJsCode || 7, message: String(error.message || error) });
            });
        },
        cancel(id) {
            const request = pending.get(id);
            if (!request) return;
            request.cancelled = true;
            clearImmediate(request.timer);
            pending.delete(id);
            if (!session) renderer('cancel', { id }).catch(() => {});
        },
        release(handle) {
            if (session) session.release(handle);
            else renderer('release', { handle }).catch(() => {});
        },
        close() {
            stopped = true;
            for (const id of pending.keys()) this.cancel(id);
            if (session) session.close();
            else renderer('close', {}).catch(() => {});
        }
    };
}

function rendererJsRequest(factory, identity, op, message) {
    const key = Symbol.for('bedrock.native.javascript');
    // A page navigation destroys this store. Salt handles per document so old ones cannot alias new objects.
    const store = globalThis[key] ||= { sessions: new Map(),
        seed: (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) | BigInt(Math.floor(Math.random() * 0x100000000)) };
    const sessions = store.sessions;
    let state = sessions.get(identity);
    if (op === 'prepare') {
        if (!state) { state = { session: factory(undefined, String(BigInt('0x' + identity.replaceAll('-', '').slice(0, 16)) ^ store.seed)), pending: new Map() }; sessions.set(identity, state); }
        try { state.pending.set(message.id, state.session.prepare(message.body, message.arguments)); return { code: 0 }; }
        catch (error) { return state.session.error(error); }
    }
    if (!state) return { code: 5, message: 'The renderer JavaScript context is unavailable.' };
    if (op === 'close') { state.session.close(); sessions.delete(identity); return { code: 0 }; }
    if (op === 'release') { state.session.release(message.handle); return { code: 0 }; }
    const execute = state.pending.get(message.id);
    state.pending.delete(message.id);
    if (op === 'cancel') return { code: 0 };
    if (!execute) return { code: 6, message: 'The renderer JavaScript request was cancelled.' };
    try { return { code: 0, value: execute() }; }
    catch (error) { return state.session.error(error); }
}

module.exports = { createJsSession, createJsTransport, rendererJsRequest };
