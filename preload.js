const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Auto-updater ────────────────────────────────────────────────────────────
  // Payload: { state: 'checking'|'available'|'not-available'|'downloading'|'ready'|'error',
  //            version?, percent?, message? }
  onUpdateStatus:   (cb) => ipcRenderer.on('update-status', (_e, payload) => cb(payload)),
  getUpdateStatus:  ()   => ipcRenderer.invoke('get-update-status'),
  installUpdate:    ()   => ipcRenderer.send('install-update'),
  checkForUpdates:  ()   => ipcRenderer.send('check-for-updates'),

  // ── Native menu sync ────────────────────────────────────────────────────────
  updateMenu: (data) => ipcRenderer.send('menu-data', data),

  // ── BrowserView panel management ────────────────────────────────────────────
  // Each "webview" type panel is backed by a BrowserView in the main process.
  // The renderer drives the full lifecycle via these calls.
  bvCreate:      (data)    => ipcRenderer.send('bv-create',         data),
  bvDestroy:     (data)    => ipcRenderer.send('bv-destroy',        data),
  bvDestroyAll:  ()        => ipcRenderer.send('bv-destroy-all'),
  bvNavigate:    (data)    => ipcRenderer.send('bv-navigate',       data),
  bvReload:      (data)    => ipcRenderer.send('bv-reload',         data),
  bvSetBounds:   (data)    => ipcRenderer.send('bv-set-bounds',     data),
  bvSetAllBounds:(updates) => ipcRenderer.send('bv-set-all-bounds', updates),
  // visible=false → hide all BVs (during drag, resize, or modal open)
  // visible=true  → restore all BVs with their latest bounds
  bvSetVisible:  (visible) => ipcRenderer.send('bv-set-visible',    visible),
});
