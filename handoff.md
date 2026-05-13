# Project Overview

- **What**: Electron 29 desktop streaming dashboard for streamer `aaroneal` (Twitch/TikTok). Aggregates Twitch chat, StreamElements activity feed, Twitch stream preview, quick actions, predictions, TikTok widgets, and stream manager into a single resizable/draggable grid UI.
- **Purpose**: Replaces juggling multiple browser tabs during live streams. Single-window OS-native app with persistent layout, 7TV extension support, and auto-update via GitHub Releases.
- **Stage**: Production — actively used during live streams. v1.6.5. Stable. No known blockers.
- **Core architecture decisions**:
  - **BrowserView over `<webview>`**: All panels that need cross-origin auth or extension injection use Electron `BrowserView` (OS-level overlay), not `<webview>` DOM elements. Root cause: `<webview>` locks the guest renderer viewport at DOM-creation time regardless of CSS sizing — caused persistent viewport-cropping bug across v1.5.x that was only solved by switching to BrowserView in v1.6.0.
  - **Local HTTP server**: Renderer served via `http://localhost:3847` (not `file://`) so `parent=localhost` satisfies Twitch embed CORS policy.
  - **Single renderer file**: All UI/logic lives in `renderer/index.html` — no bundler, no framework, inline `<script>`. Intentional for minimal toolchain.
  - **Shared session `persist:main`**: BrowserViews, main window, and auth popups all share one Chromium session so auth cookies propagate everywhere (7TV, Twitch OAuth, StreamElements).

---

# Tech Stack

- **Language**: JavaScript (ES2020, no TypeScript)
- **Runtime**: Electron 29 (`^29.0.0`) — deliberately NOT upgraded to 30+ to avoid `WebContentsView` migration risk
- **UI framework**: None — vanilla JS + inline CSS in `renderer/index.html`
- **Grid library**: GridStack 10.3.1 (CDN, loaded in renderer)
- **Package manager**: npm
- **Auto-updater**: `electron-updater ^6.1.7`
- **Builder/packager**: `electron-builder ^24.13.0`
- **Installer target**: NSIS (Windows only, one-click, per-user)
- **Distribution**: GitHub Releases (public repo `larcobeats/aaroneal-dashboard`)
- **CI/CD**: None — manual `npm run publish` triggers build + GitHub release upload
- **Database**: None — all state in `localStorage` within the renderer
- **Environment**: Windows (primary). No Linux/macOS targets configured.

---

# Repository Structure

```
aaroneal-dashboard/
├── main.js              # Electron main process — all IPC, BrowserView lifecycle,
│                        #   auto-updater, native menu, local HTTP server, session setup
├── preload.js           # contextBridge — exposes electronAPI to renderer
├── renderer/
│   └── index.html       # ENTIRE renderer: HTML + CSS + JS (~1650 lines, no split files)
├── build/
│   └── icon.ico         # App icon for NSIS installer
├── package.json         # Version, scripts, electron-builder config, GitHub publish target
├── package-lock.json
└── handoff.md           # This file
```

No `src/`, no `components/`, no `routes/`, no `.env` — everything is flat.

---

# Current State

## Fully Working
- BrowserView panels: Chat (Twitch+7TV), Activity Feed (StreamElements), Live Preview (Twitch player) — all using `persist:main` session
- 7TV extension auto-detection from Chrome/Edge/Brave/Opera profile dirs; injected via `session.loadExtension()`
- StreamElements OAuth — stays in Electron via `will-navigate` trusted domain allow-list
- Auto-updater: checks GitHub Releases on launch + manual "Check for Updates" (Help menu); download progress shown in modal; "Check Again"/"Try Again" buttons for `not-available`/`error` states; cache-busted with `Cache-Control: no-cache` header
- GridStack layout: drag (`.panel-header` handle), resize (all 8 handles), float mode, `maxRow` permanently enforced (panels can never escape the viewport)
- Tiling resize: `tileAdjacentPanels()` runs on `resizestop` — trims overlapping neighbours with minimum-cost algorithm
- Double-click edge snap: snaps panel edge to nearest adjacent panel edge or window boundary
- Auto-fill on drop: panel expands into empty space after drag
- Settings modal: columns/rows (reload-required), gap/float/animate (live preview); Cancel correctly reverts all live changes via `applySettings()`
- Layout persistence: save/load named layouts; scale on columns/rows change; version-tagged (`LAYOUT_VERSION = 2`)
- Closed panel history; native menu (Layouts, Reopen Closed Panel) synced via IPC `menu-data`
- Menu bar: `autoHideMenuBar: true` — hidden by default, revealed with Alt key
- Mute toggle on stream panel: swaps `muted` URL param, calls `bvNavigate`, icon reflects actual state
- Links: non-Twitch `window.open()` → `shell.openExternal`; `twitch.tv/popout/*` → Electron popup (raid confirmations, predictions); BV navigation to bare `twitch.tv/*` → `shell.openExternal` (so chat BV isn't hijacked by profile link clicks)

## Partially Working
- **Source quality persistence**: Relies entirely on Twitch storing quality in `localStorage` under `persist:main`. Works after first manual selection. No programmatic enforcement — first launch after fresh install will default to auto quality.

## Broken / Known Bugs
- None confirmed in v1.6.5.

## Temporary Hacks / Workarounds
- `x-frame-options` and `content-security-policy` headers stripped globally via `webRequest.onHeadersReceived` on `persist:main` session. Necessary for embedding Twitch/SE in BrowserViews — side effect is that ALL security headers are removed for all BV content.
- `sandbox: false` on BrowserView `webPreferences` required for Chrome extension injection. Reduces renderer sandbox security.
- `parent=localhost` in Twitch embed URL satisfies Twitch's embed allowlist — works because renderer is served from `http://localhost:3847`.
- GridStack loaded from CDN (`jsdelivr.net`) — no offline fallback.

## Recent Major Changes (reverse chronological)
| Version | Change |
|---------|--------|
| v1.6.5 | Stream panel `type:'stream'`→`type:'webview'`+`stream:true`; `isTrustedPopup()` split from `isTrustedAuthDomain()`; `isBVPanel()` helper; `toggleStreamMute` uses `bvNavigate` |
| v1.6.4 | `autoHideMenuBar:true`; DEFAULT_SETTINGS 126×126 gap 0; removed `'twitch.tv'` from trusted domains |
| v1.6.3 | `maxRow` permanent; `tileAdjacentPanels()`; `cancelSettings()` reverts; gap slider uses `settings.rows` not `pendingSettings.rows`; `check-for-updates` IPC |
| v1.6.2 | `overflow:hidden` on `.grid-wrapper` (scrollbar jitter fix) |
| v1.6.1 | Fractional cell heights (no `Math.floor`); double-click edge snap; auto-fill on drop |
| v1.6.0 | **`<webview>` → BrowserView migration** (definitive viewport-cropping fix) |

---

# Active Objectives

No confirmed pending objectives from the last session. User has requested features incrementally — next session will likely introduce new requests.

**Anticipated follow-up work** (not yet requested, based on conversation patterns):
1. **Force Source quality on stream panel load** — inject JS into stream BV after `did-finish-load` to auto-click quality selector. Fragile; depends on Twitch DOM. Currently deferred.
2. **TikTok panel authentication** — `tikfinity.zerody.one` is in `TRUSTED_AUTH_DOMAINS` but no auth flow has been tested. UNKNOWN if it works end-to-end.
3. **Multi-monitor / DPI support** — `getBoundingClientRect()` returns logical pixels; `view.setBounds()` expects physical pixels on HiDPI displays. May cause BV misalignment on 4K monitors. ASSUMPTION: user runs 1x DPI.

---

# Important Context

### BrowserView Bounds Synchronization
BV bounds are maintained entirely from the renderer. `syncAllBVBounds()` is called after every GridStack `change`/`added`/`removed` event, window `resize`, `dragstop`, `resizestop`, and before `bvSetVisible(true)`. BVs are hidden (removed from window) during drag/resize and while any modal has `body.modal-open` class — a reference counter `_bvHideCount` prevents double-hide/show bugs when both a modal and a drag are active simultaneously.

### `isBVPanel(cfg)` — critical helper
Any panel with `cfg.type === 'webview' || cfg.type === 'stream'` is BV-backed. The `type:'stream'` alias was kept for backward compat with saved layouts that haven't been refreshed by `loadLayout` yet. `loadLayout` refreshes type/url/stream flag from `PRESETS` on load, so the alias is only relevant for the brief window between deserialization and `addPanel`.

### Session Architecture
`session.fromPartition('persist:main')` is the single shared session. Applied to: main BrowserWindow, all BrowserViews, and auth popup windows spawned by `setWindowOpenHandler`. 7TV extension is loaded into this session via `ses.loadExtension(tvPath, { allowFileAccess: true })` before the main window is created. Header stripping (`x-frame-options`, `csp`) also hooks into this session.

### Trusted Domain Split (v1.6.4/v1.6.5)
Two separate trust checks exist:
- `isTrustedAuthDomain(url)` → used by `will-navigate` handler on all webContents. Allows: `id.twitch.tv`, `passport.twitch.tv`, `streamelements.com`, `tikfinity.zerody.one`. **Does NOT include bare `twitch.tv`** — prevents chat BV from navigating away on profile link clicks.
- `isTrustedPopup(url)` → used only by `setWindowOpenHandler`. Extends auth list with `(www.)twitch.tv/popout/*` — allows raid confirmations, predictions, squad stream popouts to open in Electron with auth session.

### GridStack Configuration
- `maxRow: settings.rows` set permanently in `GridStack.init` — removing it causes panels to escape the viewport.
- `float: true` by default — panels can overlap; `tileAdjacentPanels()` is the only overlap-prevention mechanism (runs post-resize only, not post-drag).
- `disableOneColumnMode: true` — prevents GridStack from collapsing to single column on narrow viewports.
- Column CSS injected via `injectColumnCSS(columnCount)` because GridStack's built-in column CSS only covers up to 12 columns.
- Default grid: 126 columns × 126 rows, gap 0px. Gives ~11px column width and ~7px row height at 1440×900 — near-pixel positioning.

### Settings Lifecycle
- Changes to `columns` or `rows` always require `location.reload()` — GridStack cannot be recolumned in-place without breaking existing widget positions.
- `bvDestroyAll()` must be called before every `location.reload()` — main process keeps BVs alive across renderer reload otherwise, causing ghost overlays.
- `scaleLayoutColumns()` / `scaleLayoutRows()` run against `localStorage` before reload to preserve relative panel positions.
- `cancelSettings()` calls `applySettings()` to revert live gap/float/animate changes. Gap slider uses `settings.rows` (live) not `pendingSettings.rows` (pending) because GridStack still has the old row count until reload.

### Auto-Updater
- `autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' }` set on every manual check to bypass GitHub CDN caching (stale 304s caused "no update" false negatives in earlier versions).
- `_lastUpdatePayload` caches last state — "Check for Updates" menu item replays `ready` state if download already completed.
- Repo must be public on GitHub for `releases.atom` endpoint to be accessible.

### Local HTTP Server
Port `3847` hardcoded. Serves `renderer/` directory with basic MIME type map. Required because `file://` protocol breaks Twitch embed `parent=` parameter. If port is in use, app fails silently — no retry logic.

### Native Menu
Rebuilt from scratch on every `menu-data` IPC message (sent from renderer after any layout/closed-panel state change). `executeJavaScript()` used to call renderer functions from menu click handlers — `window.confirm()` and `prompt()` are replaced with custom modal implementations because they return `false`/`null` silently when invoked via `executeJavaScript()` in Electron 29.

---

# Commands

```bash
# Install dependencies
npm install

# Run in development (no hot reload — edit files and restart)
npm start

# Build Windows installer to dist/
npm run build

# Build + publish to GitHub Releases (requires GH_TOKEN env var)
npm run publish

# No test runner, no linter, no typecheck configured
```

```bash
# Manually trigger auto-update check (in running app)
# Help menu → Check for Updates
# OR via DevTools console (Ctrl+Shift+I):
window.electronAPI.checkForUpdates()
```

```bash
# Destroy all BrowserViews (emergency reset if ghost overlays appear)
# In renderer DevTools console:
window.electronAPI.bvDestroyAll(); location.reload();
```

```bash
# Inspect a BrowserView's webContents (not available via normal DevTools)
# Must be done from Electron's main process console or added temporarily to main.js:
# mainWin.getBrowserViews()[0].webContents.openDevTools({ mode: 'detach' });
```

---

# Environment Variables

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `GH_TOKEN` | Required for `npm run publish` only | GitHub personal access token with `repo` scope — used by electron-builder to create releases and upload artifacts | `ghp_xxxxxxxxxxxxxxxxxxxx` |
| `LOCALAPPDATA` | Auto-set by Windows | Used by `find7TVExtension()` to locate Chrome/Edge extension dirs | `C:\Users\aaron\AppData\Local` |
| `APPDATA` | Auto-set by Windows | Used by `find7TVExtension()` to locate Opera extension dir | `C:\Users\aaron\AppData\Roaming` |

No `.env` file. No dotenv dependency. All config is hardcoded or runtime-detected.

---

# API + Data Flow

### External Services
| Service | URL | Auth method | Panel type |
|---------|-----|-------------|------------|
| Twitch Chat | `twitch.tv/popout/{channel}/chat?popout=` | Session cookie via `persist:main` | `webview` (BV) |
| Twitch Player | `player.twitch.tv/?channel=…&parent=localhost` | None | `webview` (BV) |
| Twitch Quick Actions | `dashboard.twitch.tv/popout/u/{channel}/stream-manager/quick-actions` | Session cookie | iframe |
| Twitch Stream Manager | `dashboard.twitch.tv/u/{channel}/stream-manager` | Session cookie | iframe |
| Twitch Predictions | `twitch.tv/popout/{channel}/predictions/summary` | Session cookie | iframe |
| StreamElements Activity Feed | `streamelements.com/dashboard/{id}/activity/popout` | Session cookie via `persist:main` — **must be BV, not iframe** (SameSite blocks 3rd-party cookies in iframes) | `webview` (BV) |
| TikFinity Chat | `tikfinity.zerody.one/widget/activity-feed` | Widget key in URL | iframe |
| TikFinity Views | `tikfinity.zerody.one/widget/viewercount` | Widget key in URL | iframe |
| GitHub Releases API | `api.github.com/repos/larcobeats/aaroneal-dashboard/releases` | None (public repo) | auto-updater |

### IPC Channels (renderer → main)
| Channel | Payload | Effect |
|---------|---------|--------|
| `bv-create` | `{id, url, bounds}` | Creates BrowserView, adds to window if visible |
| `bv-destroy` | `{id}` | Removes + closes BrowserView |
| `bv-destroy-all` | — | Destroys all BVs (call before `location.reload()`) |
| `bv-navigate` | `{id, url}` | Loads new URL in existing BV |
| `bv-reload` | `{id}` | Reloads BV webContents |
| `bv-set-bounds` | `{id, bounds}` | Updates single BV bounds (x,y,w,h — logical px) |
| `bv-set-all-bounds` | `[{id, bounds}, …]` | Batch bounds update |
| `bv-set-visible` | `boolean` | Hide/show all BVs (modal/drag guard) |
| `menu-data` | `{layouts:[{name,index}], closedPanels:[{title,index}]}` | Rebuilds native menu |
| `install-update` | — | Calls `autoUpdater.quitAndInstall()` |
| `check-for-updates` | — | Triggers `triggerUpdateCheck()` with cache-bust |

### IPC Channels (main → renderer)
| Channel | Payload | Trigger |
|---------|---------|---------|
| `update-status` | `{state, version?, percent?, message?}` | auto-updater events; manual check |

### State Management
- All layout/panel state: `localStorage` in renderer (`dashboard-layout`, `dashboard-settings`, `dashboard-saved-layouts`, `dashboard-closed`, `dashboard-version`)
- BV bounds: tracked in `bvMap` (main process) and synced from renderer on every layout change
- Update state: `_lastUpdatePayload` in main process (replayed if modal opened while download already complete)

### Caching
- Auto-updater: GitHub CDN cache bypassed via `Cache-Control: no-cache` request header on every check
- GridStack/CSS loaded from CDN — no local cache control

---

# Known Issues

| # | Problem | Cause | Severity | Files | Suggested fix |
|---|---------|-------|----------|-------|---------------|
| 1 | Source quality not enforced on first launch | Twitch quality stored in `localStorage`; empty on fresh install | Low — user sets once | `renderer/index.html` PRESETS stream entry | After `did-finish-load` on stream BV, inject JS to interact with Twitch player quality API. Fragile — deferred. |
| 2 | BV misalignment on HiDPI (4K) displays | `getBoundingClientRect()` returns CSS px; `view.setBounds()` expects physical px on some Electron/OS combos | Unknown severity (untested) | `main.js` `normBounds()`, `renderer/index.html` `getBVBounds()` | Multiply bounds by `window.devicePixelRatio` before sending over IPC; divide in `normBounds()` |
| 3 | Port 3847 conflict silently breaks app | `localServer.on('error', reject)` rejects the promise but there's no user-facing error | Low — rare | `main.js` `startLocalServer()` | Try next port on EADDRINUSE; show dialog on failure |
| 4 | `tileAdjacentPanels()` only runs post-resize, not post-drag | Overlap possible after drag in float mode | Low — UX edge case | `renderer/index.html` `initGrid()` dragstop handler | Call `tileAdjacentPanels(el?.gridstackNode)` in dragstop after `autoFillPanel()` |
| 5 | CSP + X-Frame-Options stripped globally | `webRequest.onHeadersReceived` removes headers for ALL requests on `persist:main` | Security — accepted tradeoff for embedding | `main.js` `setupHeaderStripping()` | No practical fix without breaking embeds |
| 6 | 7TV extension not found on non-standard browser install paths | `find7TVExtension()` only checks hardcoded Chrome/Edge/Brave/Opera paths | Low — cosmetic (7TV just won't inject) | `main.js` `find7TVExtension()` | Add Firefox profile path; allow user to manually specify extension path in settings |

---

# Next Recommended Actions

> Execute in order. Each step is independent unless noted.

1. **Verify BV misalignment on HiDPI** — ask user if they use a 4K/HiDPI monitor. If yes, fix `getBVBounds()` to multiply by `devicePixelRatio` and update `normBounds()` accordingly before any other visual work.

2. **Test raid confirmation flow** — user confirmed raid initiated but popup was garbled in v1.6.4. With v1.6.5's `isTrustedPopup()` fix, the popup should now open in Electron with auth session. Confirm next stream.

3. **Source quality auto-set (if requested)** — hook into stream BV `did-navigate` or `did-finish-load` in `web-contents-created` listener in `main.js`; use `webContents.executeJavaScript()` to poll for the Twitch player instance and call `player.setQuality('chunked')`. Requires identifying the correct Twitch player JS API entrypoint.

4. **`tileAdjacentPanels` on dragstop** — if user reports overlap after dragging, add call in `dragstop` handler in `renderer/index.html` `initGrid()` alongside existing `autoFillPanel()`.

5. **Offline CDN fallback** — bundle GridStack locally (`npm install gridstack --save`), serve from local HTTP server. Prevents breakage if CDN is unreachable during a stream.

---

# Session Recovery Notes

### Critical Decisions Made (with rationale)
- **Stayed on Electron 29**: `WebContentsView` (Electron 30+) was evaluated and rejected — API churn risk, BrowserView works correctly on 29.
- **No TypeScript/bundler**: Intentional for zero-toolchain simplicity. Do not introduce webpack/vite/tsc without explicit user approval.
- **`float: true` in GridStack**: User explicitly wants free panel placement. Do not switch to gravity/non-float mode — it changes drag UX completely.
- **`persist:main` for all BVs**: Required for SE auth and 7TV. Do not split sessions without verifying SE + Twitch login still work.
- **Removed `twitch.tv` from `will-navigate` trusted list**: Prevents chat BV from navigating away on profile link clicks. Adding it back would re-introduce the "links open in Electron" complaint.
- **Kept `twitch.tv/popout/*` trusted in `setWindowOpenHandler`**: Needed for raid confirmation popup to have auth session. Narrowing this to a more specific pattern may break other Twitch popouts.

### What Must NOT Be Changed
- `session.fromPartition('persist:main')` on all BrowserViews — changing partition breaks SE auth and 7TV
- `sandbox: false` on BrowserView webPreferences — required for 7TV extension injection
- `maxRow: settings.rows` in `GridStack.init` — removing causes panels to escape viewport
- Call to `window.electronAPI?.bvDestroyAll()` before every `location.reload()` — omitting causes ghost BVs
- `http://localhost:3847` serving — switching to `file://` breaks Twitch embed `parent=` CORS check

### Files Considered Sensitive/Risky
- `main.js` — IPC handlers, session config, security policies. Changes here can break auth, BV lifecycle, or introduce security regressions.
- `renderer/index.html` lines 864–930 (`initGrid`, `setupResizeHandlers`) — GridStack init + maxRow + tiling logic. Subtle ordering dependencies.
- `renderer/index.html` lines 1527–1590 (`showUpdateStatus`) — update modal state machine; `_lastUpdatePayload` caching is load-bearing.

### Current Debugging Status
No active bugs being debugged. v1.6.5 shipped clean.

---

# Definition of Done

The project is considered stable/complete for its current scope when:

- [ ] BV bounds are pixel-perfect on both 1x and HiDPI (2x) display scaling
- [ ] Raid confirmation popup opens in Electron with correct auth (confirmed in next live stream)
- [ ] Stream panel plays continuously through all focus/blur/minimize cycles without pause
- [ ] Quality persists as Source after first manual selection across restarts
- [ ] No ghost BVs or layout corruption after 4+ hours of continuous use
- [ ] Auto-updater successfully delivers a release end-to-end (build → GitHub → running app installs)
- [ ] All panel types (webview BV, stream BV, iframe) render correctly after layout save/reload cycle
- [ ] Settings cancel reverts all live changes with zero visual glitch
- [ ] No Electron windows opened for non-auth external links (Twitch profile clicks, external URLs in chat)
