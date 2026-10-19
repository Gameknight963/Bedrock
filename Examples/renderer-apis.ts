import type { RendererContext } from '../include/bedrock/renderer';

export function start(ctx: RendererContext): void {
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
