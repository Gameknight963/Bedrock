const { definePluginSettings, OptionType } = Bedrock;

export const settings = definePluginSettings({
    accent: {
        type: OptionType.BOOLEAN,
        label: 'Show accent',
        description: 'Add an accent along the top of each plugin card.',
        default: true
    },
    color: {
        type: OptionType.SELECT,
        label: 'Accent color',
        description: 'Choose the color of the accent.',
        default: '#5865f2',
        options: [
            { label: 'Blurple', value: '#5865f2' },
            { label: 'Green', value: '#23a559' },
            { label: 'Pink', value: '#eb459e' }
        ]
    }
});

export async function start(ctx) {
    const response = await fetch(new URL('./style.css', import.meta.url));
    if (!response.ok) throw new Error(`Cannot load stylesheet: ${response.status}`);
    const css = await response.text();
    let remove;
    const apply = () => {
        remove?.();
        if (settings.store.accent) remove = ctx.styles.add(css + `\n.bedrock-card { border-top-color: ${settings.store.color}; }`);
    };
    ctx.cleanup(settings.subscribe(apply));
    apply();
    ctx.log.info('Example enabled. Disable it to remove the accent.');
}
