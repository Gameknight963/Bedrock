const { contextBridge, webFrame } = require('electron');
contextBridge.exposeInMainWorld('fixture', { clearResourceCache: () => webFrame.clearCache() });
