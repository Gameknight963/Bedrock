const { app, BrowserWindow } = require('electron');
if (!globalThis.prepared) throw new Error('Application entry executed before plugin preparation');
app.whenReady().then(() => {
    const window = new BrowserWindow({ show: false });
    if (!globalThis.preparedWindowSeen) throw new Error('Early window hook missed the first window');
    console.log('PASS: Preparation completed before application entry and first window.');
    window.destroy(); app.quit();
});
