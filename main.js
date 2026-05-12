const { app, BrowserWindow, session, shell, Menu, ipcMain } = require('electron');
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
  const local  = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA    || path.join(os.homedir(), 'AppData', 'Roaming');

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
  // Avoid double-registering on the same session object
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
  'twitch.tv', 'id.twitch.tv', 'passport.twitch.tv',
  'streamelements.com',
  'tikfinity.zerody.one',
];

function isTrustedAuthDomain(url) {
  try {
    const host = new URL(url).hostname;
    return TRUSTED_AUTH_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

function applyWindowOpenHandler(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isTrustedAuthDomain(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 750,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            // Explicitly share the same session so auth cookies carry back
            session: session.defaultSession,
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Native menu ─────────────────────────────────────────────────────────────

let mainWin = null;
let menuData = { layouts: [], closedPanels: [] };

function buildMenu() {
  if (!mainWin) return;
  const win = mainWin;
  const js = (code) => () => win.webContents.executeJavaScript(code).catch(() => {});

  // Dynamic layouts submenu
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

  // Dynamic reopen-closed-panel submenu
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
            // Show the renderer's update modal immediately, then kick off the check.
            // autoUpdater events will update the modal state as they fire.
            sendUpdateStatus({ state: 'checking' });
            autoUpdater.checkForUpdates().catch(err =>
              sendUpdateStatus({ state: 'error', message: err.message })
            );
          }},
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Renderer sends this whenever layouts or closed panels change
ipcMain.on('menu-data', (_e, data) => {
  menuData = data;
  buildMenu();
});

// ─── Auto-updater → renderer UI ───────────────────────────────────────────────
// All update lifecycle events are forwarded to the renderer as a single
// 'update-status' channel so the renderer can drive its own modal UI.
// Root cause of the broken "Check for Updates" button: these listeners were
// completely absent — events fired into /dev/null and nothing reached the UI.

function sendUpdateStatus(payload) {
  mainWin?.webContents.send('update-status', payload);
}

autoUpdater.on('checking-for-update',  ()     => sendUpdateStatus({ state: 'checking' }));
autoUpdater.on('update-available',     info   => sendUpdateStatus({ state: 'available',     version: info.version }));
autoUpdater.on('update-not-available', info   => sendUpdateStatus({ state: 'not-available', version: info.version }));
autoUpdater.on('download-progress',    prog   => sendUpdateStatus({ state: 'downloading',   percent: Math.round(prog.percent) }));
autoUpdater.on('update-downloaded',    info   => sendUpdateStatus({ state: 'ready',         version: info.version }));
autoUpdater.on('error',                err    => sendUpdateStatus({ state: 'error',         message: err.message }));

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

// ─── Main window ──────────────────────────────────────────────────────────────

async function createWindow() {
  await startLocalServer();

  const ses = session.defaultSession;
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

  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    title: 'Aaroneal Dashboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  buildMenu();
  applyWindowOpenHandler(mainWin.webContents);
  mainWin.loadURL(`http://localhost:${PORT}`);
  // Silent background check on launch — events flow to renderer via sendUpdateStatus
  autoUpdater.checkForUpdates().catch(() => { /* ignore startup check failures (dev mode, no internet) */ });
}

// Apply popup policy + header stripping to every webContents (covers webviews & child windows)
app.on('web-contents-created', (_e, wc) => {
  setupHeaderStripping(wc.session);
  applyWindowOpenHandler(wc);

  // Intercept same-tab navigation inside embedded webviews.
  // Auth domains (Twitch, StreamElements, etc.) are allowed to navigate freely
  // so OAuth redirect chains work.  Everything else opens in the system browser
  // so clicking a URL posted in chat doesn't replace the panel.
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
  if (localServer) localServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
