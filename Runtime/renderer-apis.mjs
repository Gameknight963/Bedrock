export function createRendererApis({ react, report = () => {} }) {
    const menuHooks = new Map();
    const messageHooks = { send: [], edit: [] };
    const proxies = new WeakMap();
    const components = new WeakMap();
    let itemType;
    const contextKey = '__bedrockContextMenuProps';
    const cloneChildren = (React, children) => Array.isArray(children) ? children.map(child => cloneChildren(React, child)) :
        React.isValidElement(children)
            ? React.cloneElement(children, children.props.children === undefined ? {} : { children: cloneChildren(React, children.props.children) }) : children;
    function identifyItem(children) {
        for (const child of Array.isArray(children) ? children : [children]) {
            if (!child || typeof child !== 'object') continue;
            const props = child.props;
            if (props?.id && props.label && typeof props.action === 'function' &&
                !Object.hasOwn(props, 'checked') && !props.control && !props.render) itemType ||= child.type;
            if (Array.isArray(child)) identifyItem(child);
            else if (props?.children) identifyItem(props.children);
        }
    }
    function patchTree(node, context, depth = 0) {
        const React = react();
        if (!React || depth > 30) return node;
        if (Array.isArray(node)) return node.map(child => patchTree(child, context, depth + 1));
        if (!React.isValidElement(node)) return node;
        if (typeof node.props.navId === 'string') {
            identifyItem(node.props.children);
            let children = cloneChildren(React, node.props.children);
            if (!Array.isArray(children)) children = [children];
            for (const hook of menuHooks.get(node.props.navId) || []) {
                const draft = cloneChildren(React, children);
                try {
                    const result = hook.callback(draft, context);
                    if (result?.then) { Promise.resolve(result).catch(error => report(hook.id, error)); throw new Error('Context-menu patches must be synchronous.'); }
                    children = draft;
                } catch (error) { report(hook.id, error); }
            }
            return React.cloneElement(node, { children });
        }
        if (typeof node.type === 'function' || typeof node.type === 'object') {
            const type = wrapComponent(node.type);
            if (type !== node.type) {
                const ref = node.props.ref ?? Object.getOwnPropertyDescriptor(node, 'ref')?.value;
                return React.createElement(type, { ...node.props, ...(ref ? { ref } : {}), key: node.key, [contextKey]: context });
            }
        }
        return React.cloneElement(node, { children: patchTree(node.props.children, context, depth + 1) });
    }
    function wrapComponent(type) {
        if (!type || components.has(type)) return components.get(type) || type;
        const React = react();
        let wrapped;
        if (typeof type === 'function' && type.prototype?.isReactComponent) {
            wrapped = class extends type {
                render() { return patchTree(super.render(), { ...this.props[contextKey], ...this.props }); }
            };
        } else if (typeof type === 'function') {
            wrapped = function BedrockContextMenu(input) {
                const { [contextKey]: context, ...props } = input;
                return patchTree(type(props), { ...context, ...props });
            };
        } else if (type.$$typeof === Symbol.for('react.memo')) {
            wrapped = React.memo(wrapComponent(type.type), type.compare);
        } else if (type.$$typeof === Symbol.for('react.forward_ref')) {
            wrapped = React.forwardRef((input, ref) => {
                const { [contextKey]: context, ...props } = input;
                return patchTree(type.render(props, ref), { ...context, ...props });
            });
        }
        if (wrapped) { components.set(type, wrapped); components.set(wrapped, wrapped); }
        return wrapped || type;
    }
    function wrapRendered(node) {
        return patchTree(node, node?.props || {});
    }
    async function invokeMessage(kind, original, receiver, args) {
        const index = kind === 'send' ? 1 : 2;
        if (!args[index] || typeof args[index].content !== 'string') return original.apply(receiver, args);
        let message = { ...args[index] };
        for (const hook of [...messageHooks[kind]]) {
            if (!hook.active) continue;
            let cancelled = false;
            const draft = { ...message };
            try {
                await hook.callback({ channelId: args[0], ...(kind === 'edit' ? { messageId: args[1] } : {}),
                    message: draft, signal: hook.signal, cancel() { cancelled = true; } });
                if (!hook.active) continue;
                if (typeof draft.content !== 'string') throw new Error('Message content must be a string.');
            } catch (error) {
                if (!hook.active) continue;
                const failure = new Error(`${hook.id}: ${kind} hook failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                report(hook.id, failure); throw failure;
            }
            if (cancelled) {
                const error = new Error(`${hook.id} cancelled the message ${kind}.`);
                error.name = 'BedrockMessageCancelledError';
                throw error;
            }
            message = draft;
        }
        const values = [...args]; values[index] = message;
        return original.apply(receiver, values);
    }
    function observe(exports) {
        if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return exports;
        if (proxies.has(exports)) return proxies.get(exports);
        let messages = false, menus = false;
        try {
            messages = typeof exports.sendMessage === 'function' && typeof exports.editMessage === 'function';
            menus = typeof exports.openContextMenu === 'function' || typeof exports.openContextMenuLazy === 'function';
        } catch { return exports; }
        if (!messages && !menus) {
            const nested = Object.keys(exports).some(key => {
                try {
                    const value = exports[key];
                    return value && typeof value === 'object' &&
                        ((typeof value.sendMessage === 'function' && typeof value.editMessage === 'function') ||
                            typeof value.openContextMenu === 'function' || typeof value.openContextMenuLazy === 'function');
                } catch { return false; }
            });
            if (!nested) return exports;
        }
        const functions = new Map();
        const proxy = new Proxy(exports, { get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            const descriptor = Object.getOwnPropertyDescriptor(target, key);
            if (descriptor && !descriptor.configurable && Object.hasOwn(descriptor, 'value') && !descriptor.writable) return value;
            if (typeof value === 'function' && ((messages && ['sendMessage', 'editMessage'].includes(key)) ||
                (menus && ['openContextMenu', 'openContextMenuLazy'].includes(key)))) {
                const cached = functions.get(key);
                if (cached?.original === value) return cached.wrapped;
                const wrapped = function (...args) {
                    const receiver = this === proxy ? target : this;
                    if (key === 'sendMessage' || key === 'editMessage') {
                        const kind = key === 'sendMessage' ? 'send' : 'edit';
                        return messageHooks[kind].length ? invokeMessage(kind, value, receiver, args) : value.apply(receiver, args);
                    }
                    if (!menuHooks.size || typeof args[1] !== 'function') return value.apply(receiver, args);
                    const render = args[1];
                    args[1] = function (...values) {
                        const result = render.apply(this, values);
                        if (key === 'openContextMenuLazy') return Promise.resolve(result).then(callback =>
                            typeof callback === 'function' ? (...props) => wrapRendered(callback(...props)) : wrapRendered(callback));
                        return wrapRendered(result);
                    };
                    return value.apply(receiver, args);
                };
                functions.set(key, { original: value, wrapped });
                return wrapped;
            }
            // Default exports often contain the actions, while named ESM exports use read-only getters.
            return value && typeof value === 'object' && key !== 'prototype' ? observe(value) : value;
        } });
        proxies.set(exports, proxy); proxies.set(proxy, proxy);
        return proxy;
    }
    return {
        observe,
        context(id, own, signal) {
            const addMessage = (kind, callback) => {
                if (typeof callback !== 'function') throw new TypeError('Expected a message callback.');
                const hook = { id, callback, signal, active: true }; messageHooks[kind].push(hook);
                return own(() => { hook.active = false; const index = messageHooks[kind].indexOf(hook); if (index >= 0) messageHooks[kind].splice(index, 1); });
            };
            return {
                contextMenus: {
                    patch(navId, callback) {
                        if (typeof navId !== 'string' || !navId || typeof callback !== 'function') throw new TypeError('Expected a menu ID and callback.');
                        let hooks = menuHooks.get(navId);
                        if (!hooks) menuHooks.set(navId, hooks = new Set());
                        const hook = { id, callback }; hooks.add(hook);
                        return own(() => { hooks.delete(hook); if (!hooks.size) menuHooks.delete(navId); });
                    },
                    item(props) {
                        if (!props?.id || !props.label || typeof props.action !== 'function') throw new TypeError('Menu items need id, label and action.');
                        if (!itemType) throw new Error('Discord menu item component has not been observed.');
                        return react().createElement(itemType, props);
                    }
                },
                messages: { beforeSend: callback => addMessage('send', callback), beforeEdit: callback => addMessage('edit', callback) }
            };
        }
    };
}
