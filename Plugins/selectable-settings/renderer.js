export function start(ctx) {
    ctx.styles.add(`
        :is([class*="standardSidebarView_"], .bedrock-page),
        :is([class*="standardSidebarView_"], .bedrock-page) * {
            -webkit-user-select: text !important;
            user-select: text !important;
        }
    `);
}
