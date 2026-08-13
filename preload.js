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
  // Screenshot every BV (returns [{ id, dataURL }]) — call BEFORE hiding so
  // panels can show a freeze-frame while menus/modals are open above them.
  bvFreeze:      ()        => ipcRenderer.invoke('bv-freeze'),

  // ── 7TV extension status / repair ───────────────────────────────────────────
  sevenTVStatus:      ()  => ipcRenderer.invoke('seventv-status'),
  sevenTVReload:      ()  => ipcRenderer.invoke('seventv-reload'),
  sevenTVPickFolder:  ()  => ipcRenderer.invoke('seventv-pick-folder'),
  sevenTVClearManual: ()  => ipcRenderer.invoke('seventv-clear-manual'),
  sevenTVOpenPath:    ()  => ipcRenderer.send('seventv-open-path'),

  // ── Locked-mode hover watch ─────────────────────────────────────────────────
  // While active, main polls the OS cursor (mouse events over BrowserViews
  // never reach this document) and streams window-relative { x, y, inside }.
  hoverWatch:  (active) => ipcRenderer.send('hover-watch', active),
  onCursorPos: (cb)     => ipcRenderer.on('cursor-pos', (_e, pos) => cb(pos)),

  // ── Twitch dashboard stats bar ──────────────────────────────────────────────
  // Main process scrapes the stats strip from a hidden Stream Manager view and
  // pushes [{ label, value }, …] every few seconds while started.
  statsStart:  (channel) => ipcRenderer.send('stats-start', channel),
  statsStop:   ()        => ipcRenderer.send('stats-stop'),
  onStatsData: (cb)      => ipcRenderer.on('stats-data', (_e, stats) => cb(stats)),
});
