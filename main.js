const { app, BrowserWindow, session, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ─── Local HTTP server ────────────────────────────────────────────────────────
// Serves the renderer folder at http://localhost:3847.
// This gives us a real http://localhost origin so the Twitch player's
// parent=localhost parameter validates correctly.

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
// Searches common Chromium browser profiles for the 7TV Chrome extension.
// Electron can load Chrome (MV2/MV3) extensions via session.loadExtension().
// Firefox/Zen extensions (.xpi) are a different format and cannot be loaded here.

// Stable and Nightly IDs — checked in order, first found wins
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
// Removes X-Frame-Options and Content-Security-Policy from every response so
// cross-origin iframes (Twitch, StreamElements, TikFinity, etc.) load freely.
// Replaces the Firefox "Ignore X-Frame-Options" browser extension entirely.

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

// ─── Main window ──────────────────────────────────────────────────────────────

async function createWindow() {
  await startLocalServer();

  const ses = session.defaultSession;
  setupHeaderStripping(ses);

  // Load 7TV Chrome extension if found in any installed Chromium browser
  const tvPath = find7TVExtension();
  if (tvPath) {
    try {
      await ses.loadExtension(tvPath, { allowFileAccess: true });
      console.log('[7TV] Loaded from:', tvPath);
    } catch (err) {
      console.warn('[7TV] Failed to load:', err.message);
    }
  } else {
    console.warn('[7TV] Not found in any Chrome/Edge/Brave profile. Install 7TV in Chrome or Edge first.');
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
      webviewTag: true,   // enables <webview> in renderer for 7TV-enabled chat
      sandbox: false,     // required when webviewTag is true
    },
  });

  // Route any window.open() calls (pop-outs, external links) to default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`http://localhost:${PORT}`);

  // Auto-updater — checks GitHub Releases for newer versions on every launch
  autoUpdater.checkForUpdatesAndNotify();
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (localServer) localServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
