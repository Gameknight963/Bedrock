import type { RendererContext } from '../include/bedrock/renderer';

export function start(ctx: RendererContext): void {
    ctx.messages.addAccessory('message-id', props =>
        ctx.react.createElement('small', null, props.message.id));

    ctx.chatBar.addButton('show-channel', props => ctx.chatBar.button({
        label: 'Show channel ID',
        disabled: props.disabled,
        icon: ctx.react.createElement('svg', { viewBox: '0 0 24 24', fill: 'currentColor' },
            ctx.react.createElement('path', { d: 'M10 3h4v2h-4zm0 6h4v12h-4z' })),
        onClick() { ctx.notifications.show({ title: 'Channel ID', body: props.channel.id }); }
    }));

    ctx.commands.register({
        name: 'bedrock-example',
        description: 'Show a local notification',
        options: [{ name: 'text', description: 'Notification text', type: 'string', required: true }],
        execute(values) { ctx.notifications.show({ title: 'Example', body: String(values.text) }); }
    });

    ctx.contextMenus.patch<{ user: { id: string } }>('user-context', (children, props) => {
        children.push(ctx.contextMenus.item({
            id: 'example-copy-user-id',
            label: 'Copy User ID',
            action() {
                navigator.clipboard.writeText(props.user.id).catch(ctx.log.error);
            }
        }));
    });

    ctx.messages.beforeSend(event => {
        event.message.content = event.message.content.replaceAll(':wave:', '\u{1F44B}');
    });
}
