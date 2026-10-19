const css = `
.bedrock-notifications{position:fixed;top:16px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:8px;width:340px;max-width:calc(100vw - 32px);pointer-events:none;font:14px var(--font-primary,sans-serif);color:var(--text-normal,#dbdee1)}
.bedrock-notification{pointer-events:auto;padding:12px;border-radius:8px;border:1px solid var(--background-modifier-accent,#ffffff14);background:var(--background-floating,#18191c);box-shadow:0 4px 16px #0005;overflow-wrap:anywhere}
.bedrock-notification[data-type=error]{border-left:3px solid var(--text-danger,#f23f43)}.bedrock-notification[data-type=success]{border-left:3px solid var(--text-positive,#23a55a)}
.bedrock-notification-header{display:flex;align-items:start;gap:8px}.bedrock-notification-title{flex:1;font-weight:600;color:var(--header-primary,#f2f3f5);text-align:left}
.bedrock-notification button{font:inherit;cursor:pointer}.bedrock-notification-title:is(button),.bedrock-notification-close{background:none;border:0;padding:0;color:inherit}
.bedrock-notification-close{color:var(--text-muted,#949ba4)!important;width:20px;height:20px;flex:none}.bedrock-notification-close:hover{color:var(--text-normal,#dbdee1)!important}
.bedrock-notification-body{white-space:pre-wrap;margin-top:6px;line-height:1.4;user-select:text}.bedrock-notification-actions{display:flex;gap:8px;margin-top:10px}
.bedrock-notification-actions button{border:0;border-radius:3px;padding:5px 10px;background:var(--button-secondary-background,#4e5058);color:var(--button-secondary-text,#fff)}
.bedrock-notification button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
`;

export function createNotifications({ document = globalThis.document, report = () => {} } = {}) {
    let container;
    function ensureContainer() {
        if (!document) throw new Error('Notifications require a document.');
        if (!document.getElementById('bedrock-notification-style')) {
            const style = document.createElement('style'); style.id = 'bedrock-notification-style'; style.textContent = css;
            document.documentElement.append(style);
        }
        if (!container?.isConnected) {
            container = document.createElement('section'); container.className = 'bedrock-notifications';
            container.setAttribute('aria-label', 'Plugin notifications');
            (document.body || document.documentElement).append(container);
        }
    }
    return {
        context(id, own) {
            return { show(options) {
                if (!options || typeof options.title !== 'string' || !options.title.trim()) throw new TypeError('A notification needs a title.');
                const timeout = options.timeout ?? 5000;
                if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483647) throw new TypeError('Notification timeout must be between 0 and 2147483647 milliseconds.');
                if (options.body !== undefined && typeof options.body !== 'string') throw new TypeError('Notification body must be text.');
                if (options.type !== undefined && !['info', 'success', 'error'].includes(options.type)) throw new TypeError('Unknown notification type.');
                if (options.onClick !== undefined && typeof options.onClick !== 'function') throw new TypeError('Expected a notification click callback.');
                if (options.actions !== undefined && (!Array.isArray(options.actions) || options.actions.some(action =>
                    !action || typeof action.label !== 'string' || !action.label.trim() || typeof action.onClick !== 'function')))
                    throw new TypeError('Notification actions need a label and click callback.');
                ensureContainer();
                let timer, closed = false;
                const card = document.createElement('div'); card.className = 'bedrock-notification';
                card.dataset.type = options.type || 'info';
                card.setAttribute('role', options.type === 'error' ? 'alert' : 'status');
                const close = own(() => { closed = true; clearTimeout(timer); card.remove(); });
                const invoke = callback => {
                    if (closed) return;
                    try { Promise.resolve(callback()).catch(error => report(id, error)); }
                    catch (error) { report(id, error); }
                };
                const header = document.createElement('div'); header.className = 'bedrock-notification-header';
                const title = document.createElement(options.onClick ? 'button' : 'strong');
                title.className = 'bedrock-notification-title'; title.textContent = options.title;
                if (options.onClick) { title.type = 'button'; title.addEventListener('click', () => invoke(options.onClick)); }
                const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'bedrock-notification-close';
                dismiss.textContent = '\u00d7'; // Multiplication sign used as the close icon.
                dismiss.setAttribute('aria-label', 'Dismiss notification'); dismiss.addEventListener('click', close);
                header.append(title, dismiss); card.append(header);
                if (options.body) {
                    const body = document.createElement('div'); body.className = 'bedrock-notification-body'; body.textContent = options.body;
                    card.append(body);
                }
                if (options.actions?.length) {
                    const actions = document.createElement('div'); actions.className = 'bedrock-notification-actions';
                    for (const action of options.actions) {
                        const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
                        button.addEventListener('click', () => invoke(action.onClick)); actions.append(button);
                    }
                    card.append(actions);
                }
                if (!closed) {
                    container.append(card);
                    if (timeout) timer = setTimeout(close, timeout);
                }
                return Object.freeze({ close });
            } };
        }
    };
}
