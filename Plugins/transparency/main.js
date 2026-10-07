export function start(ctx) {
    ctx.windows.beforeCreate(options => {
        options.transparent = true;
        options.backgroundColor = '#00000000';
        // Electron requires frameless windows for transparency on Windows.
        options.frame = false;
    });
}
