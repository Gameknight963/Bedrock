import { createNotifications } from './notifications.mjs';

const host = 'globalThis.Bedrock._rendererUi';
const optionTypes = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, mentionable: 9, number: 10, attachment: 11 };
const buttonCss = `.bedrock-chat-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:4px;border:0;border-radius:4px;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer}.bedrock-chat-button:hover{color:var(--interactive-hover,#dbdee1);background:var(--background-modifier-hover,#ffffff0f)}.bedrock-chat-button:disabled{opacity:.5;cursor:default}.bedrock-chat-button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:-2px}.bedrock-chat-button svg{width:24px;height:24px}`;

export function createRendererUi({ react, report = () => {}, document = globalThis.document } = {}) {
    const notifications = createNotifications({ document, report });
    const registries = { accessories: new Map(), buttons: new Map(), messageButtons: new Map() };
    const listeners = new Set(), commandEntries = new Map(), commandLists = new Set();
    let revision = 0, sequence = 0, nextCommandId = -1000000000, Boundary, Slots;
    let patchStatus = [];
    const notify = () => { revision++; for (const listener of [...listeners]) listener(); };
    function getReact() {
        const React = react();
        if (!React) throw new Error('Discord React is not available yet. Access ctx.react inside a component or after waiting for React.');
        return React;
    }
    function slot(kind, props) {
        const React = getReact();
        if (!Boundary) {
            Boundary = class BedrockPluginBoundary extends React.Component {
                state = { failed: false };
                static getDerivedStateFromError() { return { failed: true }; }
                componentDidCatch(error) { report(this.props.owner, error); }
                render() { return this.state.failed ? null : this.props.children; }
            };
            Slots = function BedrockPluginSlots({ kind, input }) {
                React.useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => revision);
                return [...registries[kind].values()].sort((a, b) => a.order - b.order || a.sequence - b.sequence)
                    .map(entry => React.createElement(Boundary, { key: entry.sequence, owner: entry.owner },
                        React.createElement(kind === 'messageButtons' ? MessageButton : entry.component, { ...input, signal: entry.signal, ...(kind === 'messageButtons' ? { entry } : {}) })));
            };
        }
        return React.createElement(Slots, { key: `bedrock-${kind}`, kind, input: props || {} });
    }
    function MessageButton({ entry, nativeMessageButton, ...input }) {
        if (!nativeMessageButton || !input.message) return null;
        const options = entry.component(input);
        if (options == null) return null;
        if (options.then || typeof options.label !== 'string' || !options.label.trim() || !options.icon || typeof options.onClick !== 'function')
            throw new TypeError('Message buttons need a label, icon component and click callback.');
        return getReact().createElement(nativeMessageButton, { ...options, message: input.message, channel: input.channel,
            onClick(event) {
                if (!entry.active || entry.signal.aborted || options.disabled) return;
                try { Promise.resolve(options.onClick(event)).catch(error => report(entry.owner, error)); }
                catch (error) { report(entry.owner, error); }
            } });
    }
    function register(kind, owner, id, component, options, own, signal) {
        if (typeof id !== 'string' || !id || typeof component !== 'function') throw new TypeError('Expected an ID and React component.');
        const order = options?.order ?? 0;
        if (!Number.isFinite(order)) throw new TypeError('Component order must be a finite number.');
        const key = JSON.stringify([owner, id]);
        if (registries[kind].has(key)) throw new Error(`Component '${id}' is already registered by ${owner}.`);
        const entry = { owner, component, signal, order, sequence: ++sequence, active: true };
        registries[kind].set(key, entry);
        const dispose = own(() => { entry.active = false; registries[kind].delete(key); notify(); });
        notify(); return dispose;
    }
    function prepareOption(option) {
        if (!option || !/^[a-z0-9_-]{1,32}$/.test(option.name) || typeof option.description !== 'string' || !option.description.trim() || !Object.hasOwn(optionTypes, option.type))
            throw new TypeError('Command options need a name, description and supported type.');
        const choices = option.choices?.map(choice => {
            if (!choice || typeof choice.name !== 'string' || !choice.name.trim() ||
                (option.type === 'string' ? typeof choice.value !== 'string' :
                    !['integer', 'number'].includes(option.type) || !Number.isFinite(choice.value) || option.type === 'integer' && !Number.isInteger(choice.value)))
                throw new TypeError('Command choices must match the option type.');
            return { name: choice.name, displayName: choice.name, value: choice.value };
        });
        return { name: option.name, displayName: option.name, description: option.description, displayDescription: option.description,
            type: optionTypes[option.type], required: option.required === true, ...(choices ? { choices } : {}) };
    }
    function insertCommand(list, entry) {
        if (list.includes(entry.native)) return;
        if (list.some(command => command.name === entry.native.name || command.untranslatedName === entry.native.name)) {
            report(entry.owner, new Error(`/${entry.native.name} is already used by Discord. The plugin command was not added.`));
            return;
        }
        while ([...commandLists].some(commands => commands.some(command => command.id === String(nextCommandId)))) nextCommandId--;
        if (!entry.native.id) entry.native.id = String(nextCommandId--);
        list.push(entry.native);
    }
    const api = {
        // These hooks belong to Bedrock. Plugin registrations can disappear without undoing source patches.
        patches: [
            { id: 'message-buttons', find: '.Lv7LxN}),children', replacement: { match: /^[\s\S]*$/, replace(source) {
                const marker = source.indexOf('.Lv7LxN}),children');
                const tail = source.slice(marker, marker + 400);
                const children = /children:(\[[\w$]+,[\w$]+\])/.exec(tail);
                const controls = [...source.slice(0, marker).matchAll(/(\(0,[\w$]+\.jsxs?\)\()([\w$]+(?:\.[\w$]+)?)(,\{label:)/g)];
                if (!children || !controls.length) throw new Error('Could not locate the message toolbar or its button component.');
                const control = controls.at(-1);
                const offset = marker + children.index + 'children:'.length;
                return source.slice(0, offset) + `${host}.messageButtons(${children[1]},arguments[0],${control[2]})` + source.slice(offset + children[1].length);
            } } },
            { id: 'message-accessories', find: 'renderSuppressConfirmModal', all: true,
                replacement: { match: /this\.renderSuppressConfirmModal\(\)/g,
                    replace: `${host}.accessories($&,this.props)` } },
            { id: 'chat-buttons', find: '"sticker")',
                replacement: { match: /^[\s\S]*$/, replace(source) {
                    let changed = false;
                    const output = source.replace(/0===([$\w]+)\.length/g, (match, name, offset) => {
                        const tail = source.slice(offset + match.length, offset + match.length + 300);
                        if (!new RegExp(`children:\\s*${name.replaceAll('$', '\\$')}\\s*[,}]`).test(tail)) return match;
                        changed = true; return `(${host}.chatButtons(${name},arguments[0]),${match})`;
                    });
                    if (!changed) throw new Error('Could not locate the composer button array.');
                    return output;
                } } },
            { id: 'local-commands', find: '"tableflip","unflip"',
                replacement: { match: /^[\s\S]*$/, replace(source) {
                    const marker = source.indexOf('"tableflip","unflip"');
                    const filters = [...source.slice(Math.max(0, marker - 250), marker).matchAll(/(?<![\w$])([$\w]+)\.filter\(/g)];
                    const filter = filters.at(-1);
                    if (!filter) throw new Error('Could not locate the built-in command list.');
                    const offset = Math.max(0, marker - 250) + filter.index;
                    return source.slice(0, offset) + `${host}.bindCommands(${filter[1]})` + source.slice(offset + filter[1].length);
                } } }
        ],
        setPatchStatus(status) { patchStatus = status; },
        diagnostics() { return { patches: patchStatus, accessories: registries.accessories.size, chatButtons: registries.buttons.size, messageButtons: registries.messageButtons.size, commands: commandEntries.size, commandLists: commandLists.size }; },
        messageButtons(original, props, component) { return [slot('messageButtons', { ...props, nativeMessageButton: component }), ...original]; },
        accessories(original, props) { return [original, slot('accessories', props)]; },
        chatButtons(buttons, props) {
            if (!Array.isArray(buttons) || !buttons.length) return;
            const element = slot('buttons', props);
            const index = buttons.findIndex(button => button?.key === element.key);
            if (index >= 0) buttons[index] = element;
            else buttons.unshift(element);
        },
        bindCommands(list) {
            if (!Array.isArray(list)) return list;
            commandLists.add(list);
            for (const entry of commandEntries.values()) insertCommand(list, entry);
            return list;
        },
        context(owner, own, signal) {
            const alerts = notifications.context(owner, own);
            return {
                get react() { return getReact(); },
                notifications: alerts,
                addAccessory: (id, component, options) => register('accessories', owner, id, component, options, own, signal),
                addMessageButton: (id, factory, options) => register('messageButtons', owner, id, factory, options, own, signal),
                chatBar: {
                    addButton: (id, component, options) => register('buttons', owner, id, component, options, own, signal),
                    button(options) {
                        if (!options || typeof options.label !== 'string' || !options.label.trim() || typeof options.onClick !== 'function') throw new TypeError('Chat buttons need a label and click callback.');
                        if (document && !document.getElementById('bedrock-chat-button-style')) {
                            const style = document.createElement('style'); style.id = 'bedrock-chat-button-style'; style.textContent = buttonCss;
                            document.documentElement.append(style);
                        }
                        return getReact().createElement('button', { type: 'button', className: 'bedrock-chat-button', title: options.label,
                            'aria-label': options.label, disabled: options.disabled === true,
                            'aria-pressed': options.pressed, onClick(event) {
                                if (signal.aborted) return;
                                try { Promise.resolve(options.onClick(event)).catch(error => report(owner, error)); }
                                catch (error) { report(owner, error); }
                            } }, options.icon);
                    }
                },
                commands: { register(definition) {
                    if (!definition || !/^[a-z0-9_-]{1,32}$/.test(definition.name) || typeof definition.description !== 'string' || !definition.description.trim() || typeof definition.execute !== 'function')
                        throw new TypeError('Commands need a lowercase name, description and execute callback.');
                    if (commandEntries.has(definition.name) || [...commandLists].some(list => list.some(command => command.name === definition.name || command.untranslatedName === definition.name)))
                        throw new Error(`Command /${definition.name} is already registered.`);
                    if (definition.options !== undefined && !Array.isArray(definition.options)) throw new TypeError('Command options must be an array.');
                    const options = (definition.options || []).map(prepareOption);
                    if (new Set(options.map(option => option.name)).size !== options.length) throw new TypeError('Command option names must be unique.');
                    if (options.some((option, index) => option.required && options.slice(0, index).some(previous => !previous.required)))
                        throw new TypeError('Required command options must precede optional options.');
                    const entry = { owner, active: true, native: {
                        name: definition.name, displayName: definition.name, untranslatedName: definition.name,
                        description: definition.description, displayDescription: definition.description, untranslatedDescription: definition.description,
                        applicationId: '-1', type: 1, inputType: 0, options,
                        async execute(args, context) {
                            if (!entry.active || signal.aborted) return;
                            try {
                                const values = Object.create(null);
                                for (const option of options) {
                                    const argument = args.find(argument => argument.name === option.name);
                                    if (!argument) { if (option.required) throw new Error(`Missing option ${option.name}.`); continue; }
                                    let value = argument.value;
                                    if ([4, 10].includes(option.type) && typeof value === 'string' && value.trim()) value = Number(value);
                                    if (option.type === 5 && ['true', 'false'].includes(value)) value = value === 'true';
                                    if (option.type === 3 && typeof value !== 'string' || option.type === 4 && !Number.isInteger(value) ||
                                        option.type === 5 && typeof value !== 'boolean' || option.type === 10 && !Number.isFinite(value))
                                        throw new Error(`Invalid value for option ${option.name}.`);
                                    if (option.choices && !option.choices.some(choice => choice.value === value)) throw new Error(`Invalid choice for option ${option.name}.`);
                                    values[option.name] = value;
                                }
                                await definition.execute(values, { ...context, channelId: context.channel?.id, signal });
                            } catch (error) {
                                if (!entry.active || signal.aborted) return;
                                report(owner, error);
                                alerts.show({ title: `/${definition.name} failed`, body: error instanceof Error ? error.message : String(error), type: 'error' });
                            }
                        }
                    } };
                    commandEntries.set(definition.name, entry);
                    const dispose = own(() => {
                        entry.active = false; commandEntries.delete(definition.name);
                        for (const list of commandLists) {
                            const index = list.indexOf(entry.native);
                            if (index >= 0) list.splice(index, 1);
                        }
                    });
                    for (const list of commandLists) insertCommand(list, entry);
                    return dispose;
                } }
            };
        }
    };
    return api;
}
