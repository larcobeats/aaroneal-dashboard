const { app, BrowserWindow, BrowserView, session, shell, Menu, ipcMain, Notification, screen, webFrameMain } = require('electron');
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

// Compare dotted version strings numerically. Directory names are like
// "1.9.4_0"; a plain lexicographic sort ranks "1.9.4" above "1.10.0", which
// would pin the app to an outdated build after 7TV's next minor release.
function compareVersions(a, b) {
  const parse = v => String(v).split('_')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return null; }
}

// Collect every 7TV install on the machine (all browsers, all profiles) so the
// newest can win and the rest can be shown in the status window.
function find7TVCandidates() {
  const local   = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA      || path.join(os.homedir(), 'AppData', 'Roaming');
  const found = [];

  const add = (dir, browser) => {
    if (!is7TVManifest(path.join(dir, 'manifest.json'))) return;
    const m = readManifest(dir);
    found.push({
      path: dir,
      browser,
      version: m?.version || 'unknown',
      manifestVersion: m?.manifest_version || null,
    });
  };

  // ── Chrome-family browsers (unpacked extension directories) ──────────────
  const chromeBases = [
    [path.join(local,  'Microsoft', 'Edge', 'User Data'),               'Edge'],
    [path.join(local,  'Google', 'Chrome', 'User Data'),                'Chrome'],
    [path.join(local,  'Google', 'Chrome Beta', 'User Data'),           'Chrome Beta'],
    [path.join(local,  'Google', 'Chrome SxS', 'User Data'),            'Chrome Canary'],
    [path.join(local,  'BraveSoftware', 'Brave-Browser', 'User Data'),  'Brave'],
    [path.join(local,  'Vivaldi', 'User Data'),                         'Vivaldi'],
    [path.join(roaming,'Opera Software', 'Opera Stable'),               'Opera'],
    [path.join(roaming,'Opera Software', 'Opera GX Stable'),            'Opera GX'],
  ];

  for (const [base, browser] of chromeBases) {
    if (!fs.existsSync(base)) continue;
    const profiles = ['Default'];
    try {
      fs.readdirSync(base).filter(e => /^Profile \d+$/.test(e)).forEach(e => profiles.push(e));
    } catch {}

    for (const profile of profiles) {
      const extRoot = path.join(base, profile, 'Extensions');
      let ids;
      try { ids = fs.readdirSync(extRoot); } catch { continue; }

      for (const id of ids) {
        const idPath = path.join(extRoot, id);
        try {
          const versions = fs.readdirSync(idPath)
            .filter(v => { try { return fs.statSync(path.join(idPath, v)).isDirectory(); } catch { return false; } })
            .sort(compareVersions);
          if (versions.length === 0) continue;
          add(path.join(idPath, versions[versions.length - 1]), `${browser} (${profile})`);
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
          if (fs.statSync(fullPath).isDirectory()) {
            add(fullPath, 'Firefox (unpacked)'); // developer-mode install
          } else if (file.endsWith('.xpi') && /7tv|seventv/i.test(file)) {
            const extracted = extractXpi(fullPath);
            if (extracted) add(extracted, 'Firefox');
          }
        } catch {}
      }
    }
  }

  return found;
}

// Newest version wins, regardless of which browser it came from.
function find7TVExtension() {
  const manual = loadManualExtPath();
  if (manual && is7TVManifest(path.join(manual, 'manifest.json'))) {
    const m = readManifest(manual);
    return { path: manual, browser: 'Manual folder', version: m?.version || 'unknown',
             manifestVersion: m?.manifest_version || null, manual: true };
  }
  const all = find7TVCandidates();
  if (all.length === 0) return null;
  all.sort((a, b) => compareVersions(a.version, b.version));
  return { ...all[all.length - 1], candidates: all.length };
}

// ─── 7TV load / status / repair ───────────────────────────────────────────────
// The browser owns the extension's updates; this app just loads whatever build
// is on disk. So the useful controls are: re-scan and reload without a restart,
// point at a manually downloaded build, and verify that it actually injected.

let _sevenTV = { status: 'unknown' }; // { status, version, browser, path, error, extensionId }

function manualPathFile() {
  return path.join(app.getPath('userData'), '7tv-path.json');
}
function loadManualExtPath() {
  try { return JSON.parse(fs.readFileSync(manualPathFile(), 'utf8')).path || null; }
  catch { return null; }
}
function saveManualExtPath(p) {
  try {
    if (p) fs.writeFileSync(manualPathFile(), JSON.stringify({ path: p }));
    else if (fs.existsSync(manualPathFile())) fs.rmSync(manualPathFile());
  } catch (e) { console.warn('[7TV] could not save manual path:', e.message); }
}

async function load7TV(ses) {
  const found = find7TVExtension();
  if (!found) {
    _sevenTV = { status: 'not-found' };
    console.warn('[7TV] No 7TV install found in any supported browser.');
    return _sevenTV;
  }
  // Drop any previously loaded copy so a reload picks up a new version
  try {
    for (const ext of ses.getAllExtensions()) {
      if (/7tv|seventv/i.test(ext.name)) await ses.removeExtension(ext.id);
    }
  } catch {}
  try {
    const ext = await ses.loadExtension(found.path, { allowFileAccess: true });
    _sevenTV = {
      status: 'loaded',
      version: ext.version,
      browser: found.browser,
      path: found.path,
      manual: !!found.manual,
      manifestVersion: found.manifestVersion,
      extensionId: ext.id,
      candidates: found.candidates || 1,
    };
    console.log(`[7TV] Loaded v${ext.version} from ${found.browser}: ${found.path}`);
  } catch (err) {
    _sevenTV = { status: 'error', error: err.message, path: found.path,
                 browser: found.browser, version: found.version };
    console.warn('[7TV] Failed to load:', err.message);
  }
  return _sevenTV;
}

// Ask a chat panel whether 7TV actually rendered into the page. Proves the
// difference between "extension loaded" and "extension working".
const SEVENTV_PROBE_JS = `(() => {
  try {
    return document.querySelectorAll('[class*="seventv"], [id*="seventv"], .seventv-emote').length;
  } catch { return 0; }
})()`;

async function probe7TVInjection() {
  const results = [];
  for (const [id, entry] of bvMap) {
    if (!isTwitchPopoutChat(entry.homeUrl)) continue;
    try {
      const nodes = await entry.view.webContents.executeJavaScript(SEVENTV_PROBE_JS);
      results.push({ id, nodes: Number(nodes) || 0 });
    } catch {
      results.push({ id, nodes: 0 });
    }
  }
  return results;
}

ipcMain.handle('seventv-status', async () => {
  const injection = await probe7TVInjection();
  const available = find7TVCandidates().map(c => ({
    browser: c.browser, version: c.version, path: c.path,
  })).sort((a, b) => compareVersions(a.version, b.version)).reverse();
  return { ..._sevenTV, injection, available };
});

// Re-scan disk, reload the extension, then reload chat panels so their content
// scripts run again — this is the "it broke mid-stream" repair button.
ipcMain.handle('seventv-reload', async () => {
  const ses = session.fromPartition('persist:main');
  const state = await load7TV(ses);
  if (state.status === 'loaded') {
    for (const [, entry] of bvMap) {
      if (isTwitchPopoutChat(entry.homeUrl)) {
        try { entry.view.webContents.reload(); } catch {}
      }
    }
  }
  return state;
});

ipcMain.handle('seventv-pick-folder', async () => {
  const { dialog } = require('electron');
  const res = await dialog.showOpenDialog(mainWin, {
    title: 'Select an unpacked 7TV extension folder (the one containing manifest.json)',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { cancelled: true };
  const dir = res.filePaths[0];
  if (!is7TVManifest(path.join(dir, 'manifest.json'))) {
    return { error: 'That folder does not contain a 7TV manifest.json.' };
  }
  saveManualExtPath(dir);
  return await load7TV(session.fromPartition('persist:main'));
});

ipcMain.handle('seventv-clear-manual', async () => {
  saveManualExtPath(null);
  return await load7TV(session.fromPartition('persist:main'));
});

ipcMain.on('seventv-open-path', () => {
  if (_sevenTV.path) shell.showItemInFolder(_sevenTV.path);
});

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

// ─── Freeze frames ───────────────────────────────────────────────────────────
// BrowserViews are native overlays — DOM menus/modals can never render above
// them. Instead of blanking panels while UI chrome is open, the renderer asks
// for a screenshot of every BV first, shows those in place, and only then
// hides the live views. Menus appear to float over (frozen) panel content.

ipcMain.handle('bv-freeze', async () => {
  const shots = await Promise.all([...bvMap.entries()].map(async ([id, entry]) => {
    try {
      const img = await Promise.race([
        entry.view.webContents.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('capture timeout')), 300)),
      ]);
      if (img && !img.isEmpty()) return { id, dataURL: img.toDataURL() };
    } catch {}
    return null;
  }));
  return shots.filter(Boolean);
});

// ─── Scrollbar styling for embedded pages ────────────────────────────────────
// Twitch/StreamElements pages inside panels ship the stock bulky scrollbars.
// The renderer's CSS can't reach into cross-origin frames, so inject a slim
// scrollbar style into every frame of every webContents from here.
//
// Uses the standard scrollbar-width/scrollbar-color properties (Chromium 121+)
// with !important — when set, they take precedence over any ::-webkit-scrollbar
// styling the page itself ships, so this can't be beaten by site CSS. Injection
// runs from three hooks (frame dom-ready, frame finish-load, and a full-tree
// sweep on top-level finish-load) because cross-origin iframes don't reliably
// surface through any single one.

const SCROLLBAR_INJECT_JS = `(() => {
  if (document.getElementById('__aaroneal_scrollbars')) return;
  const s = document.createElement('style');
  s.id = '__aaroneal_scrollbars';
  s.textContent = '* { scrollbar-width: thin !important; scrollbar-color: rgba(255,255,255,0.25) transparent !important; }';
  (document.head || document.documentElement).appendChild(s);
})()`;

function injectSlimScrollbars(frame, wc) {
  if (!frame) return;
  // The dashboard's own document already styles its scrollbars
  if (wc === mainWin?.webContents && frame === wc.mainFrame) return;
  try { frame.executeJavaScript(SCROLLBAR_INJECT_JS).catch(() => {}); } catch {}
}

function injectScrollbarStyles(wc) {
  wc.on('frame-created', (_e, { frame }) => {
    if (!frame) return;
    try { frame.once('dom-ready', () => injectSlimScrollbars(frame, wc)); } catch {}
  });
  wc.on('did-frame-finish-load', (_e, _isMainFrame, processId, routingId) => {
    try { injectSlimScrollbars(webFrameMain.fromId(processId, routingId), wc); } catch {}
  });
  wc.on('did-finish-load', () => {
    try { wc.mainFrame.framesInTree.forEach(f => injectSlimScrollbars(f, wc)); } catch {}
  });
}

// ─── Locked-mode hover watch ─────────────────────────────────────────────────
// While locked, panel headers are hidden and revealed by hovering a panel's
// top edge. Mouse events over BrowserViews go to the BV's own renderer and
// never reach the dashboard DOM, so the renderer can't see the hover itself.
// Instead, main polls the OS cursor position while the watch is active and
// streams window-relative coordinates; the renderer does the hit-testing.

let _hoverTimer = null;

ipcMain.on('hover-watch', (_e, active) => {
  clearInterval(_hoverTimer);
  _hoverTimer = null;
  if (!active) return;
  _hoverTimer = setInterval(() => {
    if (!mainWin || mainWin.isMinimized() || !mainWin.isVisible()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      const cb = mainWin.getContentBounds();
      mainWin.webContents.send('cursor-pos', {
        x: pt.x - cb.x,
        y: pt.y - cb.y,
        inside: pt.x >= cb.x && pt.y >= cb.y &&
                pt.x < cb.x + cb.width && pt.y < cb.y + cb.height,
      });
    } catch {}
  }, 120);
});

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
        { label: '7TV Status…', click: js('open7TVStatus()') },
        { type: 'separator' },
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

  await load7TV(ses);

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
    // Surface a broken 7TV once at startup — otherwise it's only noticed
    // mid-stream when emotes are missing.
    setTimeout(() => {
      if (_sevenTV.status === 'not-found') {
        notify('Aaroneal Dashboard', '7TV was not found. Chat emotes are disabled — see Help → 7TV Status.');
      } else if (_sevenTV.status === 'error') {
        notify('Aaroneal Dashboard', `7TV failed to load: ${_sevenTV.error}. See Help → 7TV Status.`);
      }
    }, 12000);
  });
}

// Apply popup policy + header stripping to every webContents
// (covers BrowserView guests, auth popup windows, etc.)
app.on('web-contents-created', (_e, wc) => {
  setupHeaderStripping(wc.session);
  applyWindowOpenHandler(wc);
  injectScrollbarStyles(wc);

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
  clearInterval(_hoverTimer);
  stopStats();
  for (const id of [...bvMap.keys()]) destroyBV(id);
  if (localServer) localServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
