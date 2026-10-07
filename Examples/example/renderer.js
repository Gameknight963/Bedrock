export async function start(ctx) {
    const response = await fetch(new URL('./style.css', import.meta.url));
    if (!response.ok) throw new Error(`Cannot load stylesheet: ${response.status}`);
    ctx.styles.add(await response.text());
    ctx.log.info('Example enabled. Disable it to remove the accent.');
}
