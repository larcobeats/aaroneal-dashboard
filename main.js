const { app, BrowserWindow, BrowserView, session, shell, Menu, ipcMain, Notification, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ─── Local HTTP server ────────────────────────────────────────────────────────

const PORT = 3847;
let localServer = null;

function startLocalServer() {
  return new Promise((resolve, reject) => {
    localServer = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const filePath = path.join(
        __dirname, 'renderer', urlPath === '/' ? 'index.html' : urlPath
      );
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js':   'application/javascript',
          '.css':  'text/css',
          '.png':  'image/png',
          '.ico':  'image/x-icon',
          '.svg':  'image/svg+xml',
        }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    localServer.on('error', reject);
    localServer.listen(PORT, '127.0.0.1', resolve);
  });
}

// ─── 7TV extension finder ─────────────────────────────────────────────────────

const EXT_7TV_IDS = [
  'fphegifdehlodcepfkgofelcenelpedj', // 7TV Nightly
  'imenocelblhgehldidaghmgnchchnmoh', // 7TV Stable
];

function find7TVExtension() {
  const local   = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA      || path.join(os.homedir(), 'AppData', 'Roaming');

  const browserBases = [
    path.join(local,  'Microsoft', 'Edge', 'User Data'),
    path.join(local,  'Google', 'Chrome', 'User Data'),
    path.join(local,  'Google', 'Chrome Beta', 'User Data'),
    path.join(local,  'Google', 'Chrome SxS', 'User Data'),
    path.join(local,  'BraveSoftware', 'Brave-Browser', 'User Data'),
    path.join(roaming,'Opera Software', 'Opera Stable'),
  ];

  for (const base of browserBases) {
    if (!fs.existsSync(base)) continue;
    const profiles = ['Default'];
    try {
      fs.readdirSync(base).filter(e => /^Profile \d+$/.test(e)).forEach(e => profiles.push(e));
    } catch {}

    for (const profile of profiles) {
      for (const id of EXT_7TV_IDS) {
        const extBase = path.join(base, profile, 'Extensions', id);
        if (!fs.existsSync(extBase)) continue;
        try {
          const versions = fs.readdirSync(extBase)
            .filter(v => fs.statSync(path.join(extBase, v)).isDirectory())
            .sort();
          if (versions.length > 0) return path.join(extBase, versions[versions.length - 1]);
        } catch {}
      }
    }
  }
  return null;
}

// ─── Header stripping ─────────────────────────────────────────────────────────

function setupHeaderStripping(ses) {
  if (ses._headersStripped) return;
  ses._headersStripped = true;

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.fromEntries(
      Object.entries(details.responseHeaders || {}).filter(([key]) => {
        const lower = key.toLowerCase();
        return lower !== 'x-frame-options' && lower !== 'content-security-policy';
      })
    );
    callback({ responseHeaders: headers });
  });
}

// ─── Popup / window-open policy ───────────────────────────────────────────────
// Auth flows (Twitch login, StreamElements OAuth, etc.) open inside Electron
// so cookies are shared with the same session.
// External links (chat URLs, etc.) go to the default browser.

const TRUSTED_AUTH_DOMAINS = [
  // Only specific auth subdomains — bare 'twitch.tv' is intentionally excluded
  // so that clicking channel/user links in chat opens the system browser.
  'id.twitch.tv', 'passport.twitch.tv',
  'streamelements.com',
  'tikfinity.zerody.one',
];

function isTrustedAuthDomain(url) {
  try {
    const host = new URL(url).hostname;
    return TRUSTED_AUTH_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

// Broader check used only by setWindowOpenHandler (window.open / target=_blank).
// Includes Twitch popout paths so that raid confirmations, predictions, etc.
// open as Electron popups with the shared auth session rather than in the
// system browser (where they'd have no session and appear broken).
// Regular twitch.tv navigations (username links) are handled by will-navigate
// which uses the stricter isTrustedAuthDomain — so the chat BV never hijacks
// its own page for a profile link.
function isTrustedPopup(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (TRUSTED_AUTH_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return true;
    // Twitch popout windows (raid, predictions, squad, etc.) need the auth session
    if ((hostname === 'www.twitch.tv' || hostname === 'twitch.tv') &&
        pathname.startsWith('/popout/')) return true;
    return false;
  } catch { return false; }
}

function applyWindowOpenHandler(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isTrustedPopup(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 750,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'persist:main',
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── BrowserView panel manager ───────────────────────────────────────────────
// Each "webview" type panel (chat, activity feed) is backed by a BrowserView
// rather than a <webview> DOM element.  BrowserViews are OS-level overlays
// managed entirely from the main process, so Electron always creates the guest
// renderer with exactly the right pixel dimensions — the root cause of the
// persistent viewport-cropping bug that all DOM/CSS approaches could not fix.
//
// The renderer sends IPC to create/destroy/resize/navigate views.  Bounds are
// kept in sync by the renderer after every GridStack layout change, window
// resize, scroll event, and after drag/resize ends.
//
// BrowserViews are hidden (removed from window) during:
//   • drag and resize operations — so the OS overlay doesn't swallow mouse events
//   • any modal dialog — so modals aren't obscured by the OS-level overlay
// They are restored with up-to-date bounds immediately after.

const bvMap = new Map(); // panelId → { view: BrowserView, bounds: {x,y,w,h} }
let _bvsVisible = true;  // false while any modal or drag/resize is active

function normBounds(b) {
  return {
    x:      Math.round(b.x      ?? 0),
    y:      Math.round(b.y      ?? 0),
    width:  Math.max(1, Math.round(b.w ?? b.width  ?? 1)),
    height: Math.max(1, Math.round(b.h ?? b.height ?? 1)),
  };
}

function createBV(id, url, bounds) {
  destroyBV(id); // idempotent — replace if already exists
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:main', // shares session → 7TV extension + auth cookies
      sandbox: false,            // required for Chrome extension injection
    },
  });
  view.setBounds(normBounds(bounds));
  if (_bvsVisible) mainWin?.addBrowserView(view);
  view.webContents.loadURL(url);
  bvMap.set(id, { view, bounds: { ...bounds } });
}

function destroyBV(id) {
  const entry = bvMap.get(id);
  if (!entry) return;
  try { mainWin?.removeBrowserView(entry.view); } catch {}
  try { entry.view.webContents.close();         } catch {}
  bvMap.delete(id);
}

function setBVBounds(id, bounds) {
  const entry = bvMap.get(id);
  if (!entry) return;
  entry.bounds = { ...bounds };  // persist latest bounds even while hidden
  if (!_bvsVisible) return;     // will be applied when views are restored
  entry.view.setBounds(normBounds(bounds));
}

function hideAllBVs() {
  _bvsVisible = false;
  for (const { view } of bvMap.values()) {
    try { mainWin?.removeBrowserView(view); } catch {}
  }
}

function showAllBVs() {
  _bvsVisible = true;
  for (const { view, bounds } of bvMap.values()) {
    try {
      mainWin?.addBrowserView(view);
      view.setBounds(normBounds(bounds)); // apply any updates that arrived while hidden
    } catch {}
  }
}

ipcMain.on('bv-create',         (_e, { id, url, bounds }) => createBV(id, url, bounds));
ipcMain.on('bv-destroy',        (_e, { id }) => destroyBV(id));
ipcMain.on('bv-destroy-all',    ()  => { for (const id of [...bvMap.keys()]) destroyBV(id); });
ipcMain.on('bv-navigate',       (_e, { id, url }) => { const e = bvMap.get(id); if (e) e.view.webContents.loadURL(url); });
ipcMain.on('bv-reload',         (_e, { id }) => { const e = bvMap.get(id); if (e) e.view.webContents.reload(); });
ipcMain.on('bv-set-bounds',     (_e, { id, bounds }) => setBVBounds(id, bounds));
ipcMain.on('bv-set-all-bounds', (_e, updates) => updates.forEach(({ id, bounds }) => setBVBounds(id, bounds)));
ipcMain.on('bv-set-visible',    (_e, visible) => visible ? showAllBVs() : hideAllBVs());

// ─── Native menu ─────────────────────────────────────────────────────────────

let mainWin = null;
let menuData = { layouts: [], closedPanels: [] };

function buildMenu() {
  if (!mainWin) return;
  const win = mainWin;
  const js = (code) => () => win.webContents.executeJavaScript(code).catch(() => {});

  const layoutsSubmenu = [
    { label: 'Save Current Layout…', click: js('saveCurrentAsLayout()') },
    { type: 'separator' },
  ];
  if (menuData.layouts.length === 0) {
    layoutsSubmenu.push({ label: 'No saved layouts', enabled: false });
  } else {
    menuData.layouts.forEach(l => {
      layoutsSubmenu.push({ label: l.name, click: js(`loadSavedLayout(${l.index})`) });
    });
    layoutsSubmenu.push({ type: 'separator' });
    layoutsSubmenu.push({
      label: 'Delete Layout…',
      submenu: menuData.layouts.map(l => ({
        label: l.name,
        click: js(`deleteSavedLayout(${l.index})`),
      })),
    });
  }
  layoutsSubmenu.push({ type: 'separator' });
  layoutsSubmenu.push({ label: 'Reset to Default Layout', click: js('resetLayout()') });

  const closedSubmenu = menuData.closedPanels.length === 0
    ? [{ label: 'No closed panels', enabled: false }]
    : menuData.closedPanels.map(p => ({
        label: p.title,
        click: js(`reopenPanel(${p.index})`),
      }));

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Add Panel…',           accelerator: 'CmdOrCtrl+N',  click: js('addPanelDialog()') },
        { label: 'Reopen Closed Panel',  submenu: closedSubmenu },
        { type: 'separator' },
        { label: 'Settings…',            accelerator: 'CmdOrCtrl+,',  click: js('openSettings()') },
        { type: 'separator' },
        { label: 'Quit',                 accelerator: 'Alt+F4',        click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload All Panels',      accelerator: 'CmdOrCtrl+Shift+R', click: js('reloadAll()') },
        { type: 'separator' },
        { label: 'Toggle Lock',            accelerator: 'CmdOrCtrl+L',       click: js('toggleLock()') },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I',
          click: () => win.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Layouts',
      submenu: layoutsSubmenu,
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'View on GitHub',
          click: () => shell.openExternal('https://github.com/larcobeats/aaroneal-dashboard') },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
        { label: 'Check for Updates', click: () => {
            if (_lastUpdatePayload?.state === 'ready') {
              sendUpdateStatus(_lastUpdatePayload);
              return;
            }
            triggerUpdateCheck();
          }},
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on('menu-data', (_e, data) => {
  menuData = data;
  buildMenu();
});

// ─── Auto-updater → renderer UI ───────────────────────────────────────────────

let _lastUpdatePayload = null;

function sendUpdateStatus(payload) {
  _lastUpdatePayload = payload;
  mainWin?.webContents.send('update-status', payload);
}

let _checkInProgress = false;
let _manualCheck     = false;

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function triggerUpdateCheck() {
  if (_checkInProgress) return;
  _manualCheck = true;
  _checkInProgress = true;
  autoUpdater.autoDownload = true;
  autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' };
  autoUpdater.checkForUpdates()
    .catch(err => {
      // Safety net: 'error' event handles most failures; this catches synchronous throws
      if (!_checkInProgress) return; // already handled by the error event
      _checkInProgress = false;
      const manual = _manualCheck;
      _manualCheck = false;
      sendUpdateStatus({ state: 'error', message: err.message, manual });
      if (manual) notify('Aaroneal Dashboard — Update Failed', err.message || 'Update check failed');
    });
}

ipcMain.on('check-for-updates', () => triggerUpdateCheck());
ipcMain.handle('get-update-status', () => _lastUpdatePayload);

autoUpdater.on('checking-for-update', () => { _checkInProgress = true; });

autoUpdater.on('update-available', info => {
  _checkInProgress = false;
  sendUpdateStatus({ state: 'available', version: info.version });
  if (mainWin) mainWin.setTitle(`Aaroneal Dashboard — Downloading v${info.version}…`);
});

autoUpdater.on('download-progress', prog => {
  const pct = Math.round(prog.percent);
  sendUpdateStatus({ state: 'downloading', percent: pct });
  if (mainWin) mainWin.setProgressBar(pct / 100);
});

autoUpdater.on('update-not-available', info => {
  _checkInProgress = false;
  const manual = _manualCheck;
  _manualCheck = false;
  sendUpdateStatus({ state: 'not-available', version: info.version, manual });
  if (mainWin) { mainWin.setTitle('Aaroneal Dashboard'); mainWin.setProgressBar(-1); }
  // Native notification — always visible regardless of BrowserView layout
  notify('Aaroneal Dashboard', `You're up to date — v${info.version} is the latest version.`);
});

autoUpdater.on('update-downloaded', info => {
  _checkInProgress = false;
  const manual = _manualCheck;
  _manualCheck = false;
  sendUpdateStatus({ state: 'ready', version: info.version, manual });
  if (mainWin) { mainWin.setTitle('Aaroneal Dashboard'); mainWin.setProgressBar(-1); }
});

autoUpdater.on('error', err => {
  _checkInProgress = false;
  const manual = _manualCheck;
  _manualCheck = false;
  sendUpdateStatus({ state: 'error', message: err.message, manual });
  if (mainWin) mainWin.setProgressBar(-1);
  // Only surface errors on manual checks; silent for background startup checks
  if (manual) notify('Aaroneal Dashboard — Update Failed', err.message || 'Update check failed');
});

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

// ─── Window state persistence ─────────────────────────────────────────────────
// Lazy-init the path so app.getPath() is never called before app.ready.

let _winStateFile = null;
function winStateFile() {
  if (!_winStateFile) _winStateFile = path.join(app.getPath('userData'), 'window-state.json');
  return _winStateFile;
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(winStateFile(), 'utf8'));
  } catch {}
  return { width: 1440, height: 900 };
}

function saveWindowState(win) {
  if (!win) return;
  const isMaximized = win.isMaximized();
  try {
    if (!isMaximized) {
      const [x, y]         = win.getPosition();
      const [width, height] = win.getSize();
      fs.writeFileSync(winStateFile(), JSON.stringify({ x, y, width, height, isMaximized: false }));
    } else {
      // Keep the last non-maximized bounds; just flip the flag
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(winStateFile(), 'utf8')); } catch {}
      fs.writeFileSync(winStateFile(), JSON.stringify({ ...prev, isMaximized: true }));
    }
  } catch (e) { console.warn('[winstate] save failed:', e.message); }
}

// ─── Main window ──────────────────────────────────────────────────────────────

async function createWindow() {
  await startLocalServer();

  const ses = session.fromPartition('persist:main');
  setupHeaderStripping(ses);

  const tvPath = find7TVExtension();
  if (tvPath) {
    try {
      await ses.loadExtension(tvPath, { allowFileAccess: true });
      console.log('[7TV] Loaded from:', tvPath);
    } catch (err) {
      console.warn('[7TV] Failed to load:', err.message);
    }
  } else {
    console.warn('[7TV] Not found in any Chrome/Edge/Brave profile.');
  }

  const winState = loadWindowState();

  mainWin = new BrowserWindow({
    x:      winState.isMaximized ? undefined : winState.x,
    y:      winState.isMaximized ? undefined : winState.y,
    width:  winState.width  || 1440,
    height: winState.height || 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0c0c0f',
    title: 'Aaroneal Dashboard',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'persist:main',
    },
  });

  if (winState.isMaximized) mainWin.maximize();

  // Persist window position/size across restarts
  let _winSaveTimer;
  const debouncedSave = () => {
    clearTimeout(_winSaveTimer);
    _winSaveTimer = setTimeout(() => saveWindowState(mainWin), 500);
  };
  mainWin.on('resize',   debouncedSave);
  mainWin.on('move',     debouncedSave);
  mainWin.on('maximize', debouncedSave);
  mainWin.on('close',    () => saveWindowState(mainWin));

  buildMenu();
  applyWindowOpenHandler(mainWin.webContents);
  mainWin.loadURL(`http://localhost:${PORT}`);

  // Delay the startup check until the renderer has loaded so update-status
  // events aren't silently dropped before onUpdateStatus is registered.
  mainWin.webContents.once('did-finish-load', () => {
    setTimeout(triggerUpdateCheck, 2000);
  });
}

// Apply popup policy + header stripping to every webContents
// (covers BrowserView guests, auth popup windows, etc.)
app.on('web-contents-created', (_e, wc) => {
  setupHeaderStripping(wc.session);
  applyWindowOpenHandler(wc);

  wc.on('will-navigate', (event, url) => {
    if (wc === mainWin?.webContents) return; // main window: always allow
    if (url.startsWith('http://localhost:'))  return; // local dev server: allow
    if (isTrustedAuthDomain(url))             return; // auth flows: stay in Electron
    event.preventDefault();
    shell.openExternal(url);
  });
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Destroy all BrowserViews before quitting
  for (const id of [...bvMap.keys()]) destroyBV(id);
  if (localServer) localServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
