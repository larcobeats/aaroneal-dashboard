const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the renderer for update notifications.
// Everything else (shell.openExternal, etc.) is handled in main.js.
contextBridge.exposeInMainWorld('electronAPI', {
  // All update lifecycle events are unified into one channel.
  // Payload: { state: 'checking'|'available'|'not-available'|'downloading'|'ready'|'error',
  //            version?, percent?, message? }
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, payload) => cb(payload)),
  installUpdate:  ()   => ipcRenderer.send('install-update'),
  updateMenu:     (data) => ipcRenderer.send('menu-data', data),
});
