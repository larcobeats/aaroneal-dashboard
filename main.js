const { app, BrowserWindow, BrowserView, session, shell, Menu, ipcMain, Notification, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ─── Single instance ──────────────────────────────────────────────────────────
// A second launch would fail to bind port 3847 and open a broken window;
// focus the existing window instead.

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  });
}

// ─── Local HTTP server ────────────────────────────────────────────────────────

const PORT = 3847;
let localServer = null;

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const rendererRoot = path.join(__dirname, 'renderer');
    localServer = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const filePath = path.normalize(path.join(
        rendererRoot, urlPath === '/' ? 'index.html' : urlPath
      ));
      // Never serve anything outside renderer/ (e.g. /../main.js)
      if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
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

// Detect any 7TV extension by reading manifest content — works for Stable,
// Nightly, Recommended, and any future release channels.
function is7TVManifest(manifestPath) {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    return /7tv|seventv/i.test(raw);
  } catch { return false; }
}

// Firefox stores AMO extensions as .xpi files (ZIP archives).
// Electron's loadExtension() needs an unpacked directory, so we extract to
// userData/7tv-extracted and cache by source path to avoid re-extracting.
function extractXpi(xpiPath) {
  const destDir = path.join(app.getPath('userData'), '7tv-extracted');
  const stamp   = path.join(destDir, '.source');
  try {
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === xpiPath) {
      return destDir; // already extracted from this exact file
    }
  } catch {}
  try {
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    // PowerShell's Expand-Archive is built into Windows 10+ — no extra deps needed
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${xpiPath}' -DestinationPath '${destDir}' -Force"`,
      { timeout: 15000, stdio: 'pipe' }
    );
    fs.writeFileSync(stamp, xpiPath);
    console.log('[7TV] Extracted Firefox .xpi to:', destDir);
    return destDir;
  } catch (e) {
    console.warn('[7TV] Failed to extract .xpi:', e.message);
    return null;
  }
}

function find7TVExtension() {
  const local   = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA      || path.join(os.homedir(), 'AppData', 'Roaming');

  // ── Chrome-family browsers (unpacked extension directories) ──────────────
  const chromeBases = [
    path.join(local,  'Microsoft', 'Edge', 'User Data'),
    path.join(local,  'Google', 'Chrome', 'User Data'),
    path.join(local,  'Google', 'Chrome Beta', 'User Data'),
    path.join(local,  'Google', 'Chrome SxS', 'User Data'),
    path.join(local,  'BraveSoftware', 'Brave-Browser', 'User Data'),
    path.join(roaming,'Opera Software', 'Opera Stable'),
  ];

  for (const base of chromeBases) {
    if (!fs.existsSync(base)) continue;
    const profiles = ['Default'];
    try {
      fs.readdirSync(base).filter(e => /^Profile \d+$/.test(e)).forEach(e => profiles.push(e));
    } catch {}

    for (const profile of profiles) {
      const extRoot = path.join(base, profile, 'Extensions');
      let extEntries;
      try {
        // Sort newest-first so the most recently installed 7TV release wins
        extEntries = fs.readdirSync(extRoot)
          .map(id => { try { return { id, mtime: fs.statSync(path.join(extRoot, id)).mtimeMs }; } catch { return null; } })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);
      } catch { continue; }

      for (const { id } of extEntries) {
        const idPath = path.join(extRoot, id);
        try {
          const versions = fs.readdirSync(idPath)
            .filter(v => fs.statSync(path.join(idPath, v)).isDirectory())
            .sort();
          if (versions.length === 0) continue;
          const latest = path.join(idPath, versions[versions.length - 1]);
          if (is7TVManifest(path.join(latest, 'manifest.json'))) return latest;
        } catch {}
      }
    }
  }

  // ── Firefox (extensions stored as .xpi ZIP archives) ─────────────────────
  const ffProfilesRoot = path.join(roaming, 'Mozilla', 'Firefox', 'Profiles');
  if (fs.existsSync(ffProfilesRoot)) {
    let ffProfiles;
    try { ffProfiles = fs.readdirSync(ffProfilesRoot); } catch { ffProfiles = []; }

    for (const profile of ffProfiles) {
      const extDir = path.join(ffProfilesRoot, profile, 'extensions');
      let files;
      try { files = fs.readdirSync(extDir); } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(extDir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            // Developer-mode / temporarily-installed extension
            if (is7TVManifest(path.join(fullPath, 'manifest.json'))) return fullPath;
          } else if (file.endsWith('.xpi') && /7tv|seventv/i.test(file)) {
            // Signed AMO extension — extract and return unpacked path
            const extracted = extractXpi(fullPath);
            if (extracted) return extracted;
          }
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

const bvMap = new Map(); // panelId → { view, bounds: {x,y,w,h}, homeUrl }
let _bvsVisible = true;  // false while any modal or drag/resize is active

// ─── Raid guard ──────────────────────────────────────────────────────────────
// When a raid executes ("Raid Now" or the countdown expiring), Twitch redirects
// the popout chat page itself to the raid target. That redirect is an in-page
// (SPA) navigation, so the will-navigate handler below never fires. Watch the
// chat BV's navigation events instead: any main-frame navigation away from the
// chat popout path opens the target channel in the system browser and restores
// the original chat.

function isTwitchPopoutChat(url) {
  try {
    const u = new URL(url);
    return /(^|\.)twitch\.tv$/.test(u.hostname) && /^\/popout\/[^/]+\/chat/.test(u.pathname);
  } catch { return false; }
}

function attachRaidGuard(id, view) {
  const wc = view.webContents;
  const onNav = (url) => {
    const entry = bvMap.get(id);
    if (!entry || entry.view !== view) return;      // stale view — panel was replaced
    const home = entry.homeUrl;
    if (!isTwitchPopoutChat(home)) return;          // guard only applies to chat panels
    let u, h;
    try { u = new URL(url); h = new URL(home); } catch { return; }
    if (u.pathname.startsWith(h.pathname)) return;  // still on our chat
    if (isTrustedAuthDomain(url))          return;  // login flow — leave it alone
    if (/^\/(login|signup)/.test(u.pathname)) return;
    // Raid executed — hand the target channel to the default browser
    const m = u.pathname.match(/^\/popout\/([^/]+)/);
    shell.openExternal(m ? `https://www.twitch.tv/${m[1]}` : url);
    wc.loadURL(home);
  };
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) onNav(url); });
  wc.on('did-navigate',         (_e, url) => onNav(url));
}

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
  bvMap.set(id, { view, bounds: { ...bounds }, homeUrl: url });
  attachRaidGuard(id, view);
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
ipcMain.on('bv-navigate',       (_e, { id, url }) => { const e = bvMap.get(id); if (e) { e.homeUrl = url; e.view.webContents.loadURL(url); } });
ipcMain.on('bv-reload',         (_e, { id }) => { const e = bvMap.get(id); if (e) e.view.webContents.reload(); });
ipcMain.on('bv-set-bounds',     (_e, { id, bounds }) => setBVBounds(id, bounds));
ipcMain.on('bv-set-all-bounds', (_e, updates) => updates.forEach(({ id, bounds }) => setBVBounds(id, bounds)));
ipcMain.on('bv-set-visible',    (_e, visible) => visible ? showAllBVs() : hideAllBVs());

// ─── Twitch dashboard stats scraper ──────────────────────────────────────────
// The stats strip on dashboard.twitch.tv (Session / Viewers / Followers /
// Bitrate / Subscribers / Sub Points / Pre-roll) has no popout URL, and the
// Helix API can't supply bitrate at all (nor subscriber counts without a
// registered OAuth app). So a hidden BrowserView — never attached to the
// window — loads the Stream Manager with the user's existing login session
// and reads the strip's values off the DOM every few seconds.
//
// The scrape matches on visible label text only (no CSS classes), so it
// survives Twitch styling changes. The view is destroyed whenever the stats
// bar is hidden, so it costs nothing unless the feature is in use.

let statsView  = null;
let statsTimer = null;

const STATS_SCRAPE_JS = `(() => {
  const LABELS = ['Session','Viewers','Followers','Bitrate','Horizontal','Vertical',
                  'Subscribers','Sub Points','Pre-roll On','Pre-roll Off'];
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('div,span,p,strong')) {
    if (el.children.length > 0) continue;
    const label = (el.textContent || '').trim();
    if (!LABELS.includes(label) || seen.has(label)) continue;
    // Walk up to the stat tile: the nearest ancestor whose text is the label
    // plus a short value and nothing else.
    let node = el.parentElement;
    for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
      const t = (node.textContent || '').trim();
      if (t.length > label.length && t.length <= label.length + 24) {
        const value = t.replace(label, '').trim();
        if (value) { seen.add(label); out.push({ label, value }); }
        break;
      }
    }
  }
  return out;
})()`;

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  if (statsView) {
    try { statsView.webContents.close(); } catch {}
    statsView = null;
  }
}

function startStats(channel) {
  stopStats();
  statsView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:main', // reuse the existing Twitch login
      sandbox: false,
    },
  });
  const wc = statsView.webContents;
  wc.setAudioMuted(true);
  wc.setBackgroundThrottling(false); // keep live values updating while hidden
  wc.loadURL(`https://dashboard.twitch.tv/u/${encodeURIComponent(channel)}/stream-manager`);

  const scrape = () => {
    statsView?.webContents.executeJavaScript(STATS_SCRAPE_JS)
      .then(stats => {
        if (Array.isArray(stats)) mainWin?.webContents.send('stats-data', stats);
      })
      .catch(() => {});
  };
  wc.once('did-finish-load', () => setTimeout(scrape, 4000)); // let the SPA render
  statsTimer = setInterval(scrape, 5000);
}

ipcMain.on('stats-start', (_e, channel) => {
  if (typeof channel === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(channel)) startStats(channel);
});
ipcMain.on('stats-stop', () => stopStats());

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
        { label: 'Channel Setup…',       click: js('openSetup()') },
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
        { label: 'Toggle Stats Bar',       accelerator: 'CmdOrCtrl+B',       click: js('toggleStatsBar()') },
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
  stopStats();
  for (const id of [...bvMap.keys()]) destroyBV(id);
  if (localServer) localServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
