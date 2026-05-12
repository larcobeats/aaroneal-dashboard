const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the renderer for update notifications.
// Everything else (shell.openExternal, etc.) is handled in main.js.
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info) => cb(info)),
  updateMenu: (data) => ipcRenderer.send('menu-data', data),
});
