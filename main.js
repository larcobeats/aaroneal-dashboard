const { app, BrowserWindow, session, shell, Menu, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ─── Local HTTP server ────────────────────────────────────────────────────────
// Serves renderer/ at http://localhost:3847 so Twitch player's parent=localhost works.

const PORT = 3847;
let localServer = null;

function startLocalServer() {
  return new Promise((resolve, reject) => {
    localServer = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const filePath = path.join(
        __dirname,
        'renderer',
        urlPath === '/' ? 'index.html' : urlPath
      );
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.svg': 'image/svg+xml',
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
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  const browserBases = [
    path.join(local, 'Microsoft', 'Edge', 'User Data'),
    path.join(local, 'Google', 'Chrome', 'User Data'),
    path.join(local, 'Google', 'Chrome Beta', 'User Data'),
    path.join(local, 'Google', 'Chrome SxS', 'User Data'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    path.join(roaming, 'Opera Software', 'Opera Stable'),
  ];

  for (const base of browserBases) {
    if (!fs.existsSync(base)) continue;

    const profiles = ['Default'];
    try {
      fs.readdirSync(base)
        .filter(e => /^Profile \d+$/.test(e))
        .forEach(e => profiles.push(e));
    } catch {}

    for (const profile of profiles) {
      for (const id of EXT_7TV_IDS) {
        const extBase = path.join(base, profile, 'Extensions', id);
        if (!fs.existsSync(extBase)) continue;
        try {
          const versions = fs.readdirSync(extBase)
            .filter(v => fs.statSync(path.join(extBase, v)).isDirectory())
            .sort();
          if (versions.length > 0) {
            return path.join(extBase, versions[versions.length - 1]);
          }
        } catch {}
      }
    }
  }
  return null;
}

// ─── Header stripping ─────────────────────────────────────────────────────────

function setupHeaderStripping(ses) {
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
// Auth flows (Twitch login, StreamElements OAuth, etc.) must open inside Electron.
// Arbitrary external links (chat URLs, etc.) open in the default browser.

const TRUSTED_AUTH_DOMAINS = [
  'twitch.tv',
  'streamelements.com',
  'tikfinity.zerody.one',
  'id.twitch.tv',
  'passport.twitch.tv',
];

function isTrustedAuthDomain(url) {
  try {
    const host = new URL(url).hostname;
    return TRUSTED_AUTH_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function applyWindowOpenHandler(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isTrustedAuthDomain(url)) {
      // Open login/auth popups as real Electron windows so cookies work
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 750,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    // Everything else (external links from chat, etc.) → default browser
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Native menu ─────────────────────────────────────────────────────────────

function buildMenu(win) {
  const js = (code) => () => win.webContents.executeJavaScript(code);

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Add Panel…', click: js('addPanelDialog()') },
        { type: 'separator' },
        { label: 'Reset to Default Layout', click: js('resetLayout()') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Alt+F4', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload All Panels',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: js('reloadAll()'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Lock',
          accelerator: 'CmdOrCtrl+L',
          click: js('toggleLock()'),
        },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: js('openSettings()'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => win.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: 'Layouts',
      submenu: [
        { label: 'Save Current Layout…', click: js('saveCurrentAsLayout()') },
        { label: 'Open Layouts Menu', click: js('toggleLayoutsMenu()') },
        { type: 'separator' },
        { label: 'Reopen Closed Panel', click: js('toggleClosedMenu()') },
      ],
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
        {
          label: 'View on GitHub',
          click: () => shell.openExternal('https://github.com/larcobeats/aaroneal-dashboard'),
        },
        { type: 'separator' },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
        {
          label: 'Check for Updates',
          click: () => autoUpdater.checkForUpdatesAndNotify(),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

  const win = new BrowserWindow({
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

  buildMenu(win);

  // Apply popup policy to the main window
  applyWindowOpenHandler(win.webContents);

  win.loadURL(`http://localhost:${PORT}`);

  autoUpdater.checkForUpdatesAndNotify();
}

// Apply popup policy to every webContents (covers webviews and child windows)
app.on('web-contents-created', (_e, wc) => {
  setupHeaderStripping(wc.session);
  applyWindowOpenHandler(wc);
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
