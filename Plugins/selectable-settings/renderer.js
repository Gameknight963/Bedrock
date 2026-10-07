export function start(ctx) {
    ctx.styles.add(`
        :is([class*="standardSidebarView_"], [role="dialog"]:has([class*="breadcrumbsNav_"]):has([class*="contentBody_"]), .bedrock-page),
        :is([class*="standardSidebarView_"], [role="dialog"]:has([class*="breadcrumbsNav_"]):has([class*="contentBody_"]), .bedrock-page) * {
            -webkit-user-select: text !important;
            user-select: text !important;
        }
    `);
}
