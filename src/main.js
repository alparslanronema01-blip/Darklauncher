'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// VM / remote-desktop / broken-GPU-driver environments often fail GPU
// compositing, which leaves windows invisible or blank. A launcher UI is
// simple CSS; software rendering costs nothing here and just works.
app.disableHardwareAcceleration();

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
}

const store = require('./store');
const versions = require('./versions');
const launcher = require('./launcher');
const auth = require('./auth');
const logger = require('./logger');
const fabric = require('./fabric');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const instances = require('./instances');

// In packaged builds, keep game data in the OS user-data dir; portable in dev.
if (app.isPackaged) {
  store.init(path.join(app.getPath('userData'), 'darklauncher-data'));
}
logger.init(store.appdata.logs, { minLevel: 'debug' });
const log = logger.child('main');

process.on('uncaughtException', (err) => {
  log.error('uncaught exception:', err);
  try { dialog.showErrorBox('Darklauncher error', String((err && err.stack) || err)); } catch (_) { /* headless */ }
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection:', err);
  try { dialog.showErrorBox('Darklauncher error', String((err && err.stack) || err)); } catch (_) { /* headless */ }
});

let win = null;
let tray = null;
let launching = false;
let currentChild = null;
let quitting = false;

function iconPath() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Darklauncher');
    const menu = Menu.buildFromTemplate([
      { label: 'Show Darklauncher', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => { quitting = true; app.quit(); }
      }
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => showWindow());
    log.info('tray created');
  } catch (e) {
    log.warn(`tray unavailable: ${e.message}`);
    tray = null;
  }
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  // Restore last window size/position, clamped to the visible work area.
  const bounds = store.settings.windowBounds || {};
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;

  // Drop saved positions that ended up outside every connected display
  // (e.g. the monitor was unplugged) — otherwise the window restores
  // itself onto a screen that no longer exists and looks "not opening".
  let savedX = Number.isFinite(bounds.x) ? bounds.x : undefined;
  let savedY = Number.isFinite(bounds.y) ? bounds.y : undefined;
  if (savedX !== undefined && savedY !== undefined) {
    const w = Math.min(bounds.width || 1200, area.width);
    const h = Math.min(bounds.height || 760, area.height);
    const onAnyDisplay = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return savedX < a.x + a.width && savedX + w > a.x && savedY < a.y + a.height && savedY + h > a.y;
    });
    if (!onAnyDisplay) { savedX = undefined; savedY = undefined; }
  }

  win = new BrowserWindow({
    width: Math.min(bounds.width || 1200, area.width),
    height: Math.min(bounds.height || 760, area.height),
    x: savedX,
    y: savedY,
    minWidth: 980,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: iconPath()
  });
  if (process.platform !== 'darwin' && typeof win.setMenu === 'function') win.setMenu(null);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    try { win.show(); } catch (_) { /* destroyed */ }
  });
  // Safety net: on some systems ready-to-show never fires (VMs, remote
  // desktop, GPU driver issues) and the window would stay hidden forever.
  // If the page has loaded but the window is still invisible, force-show it.
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch (_) { /* gone */ }
    }, 1200);
  });
  // Absolute last resort: even a slow environment gets its window within 6s.
  setTimeout(() => {
    try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch (_) { /* gone */ }
  }, 6000);

  win.on('maximize', () => win.webContents.send('window', 'maximized'));
  win.on('unmaximize', () => win.webContents.send('window', 'restored'));

  // Persist window bounds (debounced slightly by resize events being rare).
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    store.settings.windowBounds = win.getBounds();
    store.saveSettings();
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // closeToTray: minimize to tray unless the user is really quitting
  // or the game is running (closing then would orphan the game view).
  win.on('close', (e) => {
    if (quitting || !store.settings.closeToTray || !tray) return;
    e.preventDefault();
    win.hide();
    log.info('window hidden to tray');
  });

  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
});

app.on('before-quit', () => {
  quitting = true;
  // A running game is a child; die cleanly instead of leaving a zombie.
  if (currentChild) {
    log.info('app quitting: stopping game');
    try { launcher.killTree(currentChild.pid); } catch (_) { /* already dead */ }
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---------------------------------------------------------------- window controls
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));

ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
});

// ---------------------------------------------------------------- app info
ipcMain.handle('app:getInfo', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  dataDir: store.appdata.root,
  logFile: logger.logFile()
}));

ipcMain.handle('app:openLogs', () => {
  try {
    shell.openPath(store.appdata.logs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:recentLogs', () => logger.recentLines());

// ---------------------------------------------------------------- backgrounds
// User-picked images for animated backgrounds / floating blocks live in
// appdata/backgrounds/ and are served to the renderer via bg:* file IPC.
const pathMod = require('path');
function backgroundsDir() { return pathMod.join(store.appdata.root, 'backgrounds'); }

ipcMain.handle('bg:chooseImage', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Pick an image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const dir = backgroundsDir();
  fs.mkdirSync(dir, { recursive: true });
  const src = res.filePaths[0];
  const name = `img-${Date.now()}${pathMod.extname(src).toLowerCase() || '.png'}`;
  fs.copyFileSync(src, pathMod.join(dir, name));
  log.info(`background image added: ${name}`);
  return { ok: true, name };
});

ipcMain.handle('bg:list', () => {
  const dir = backgroundsDir();
  if (!fs.existsSync(dir)) return { ok: true, files: [] };
  return { ok: true, files: fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f)) };
});

ipcMain.handle('bg:delete', (_e, name) => {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false, error: 'Invalid name' };
  try { fs.unlinkSync(pathMod.join(backgroundsDir(), name)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message };
  }
});

// Serve a background image file body as a data URL (CSP-safe).
ipcMain.handle('bg:load', (_e, name) => {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false };
  const file = pathMod.join(backgroundsDir(), name);
  if (!fs.existsSync(file)) return { ok: false };
  const ext = pathMod.extname(name).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return { ok: true, dataUrl: `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}` };
});

// ---------------------------------------------------------------- settings
ipcMain.handle('settings:get', () => store.settings);
ipcMain.handle('settings:set', (_e, patch) => {
  Object.assign(store.settings, patch || {});
  store.saveSettings();
  log.info('settings updated');
  return store.settings;
});

// ---------------------------------------------------------------- versions
ipcMain.handle('versions:list', async (_e, includeSnapshots) => {
  try {
    return { ok: true, versions: await versions.listVersions(!!includeSnapshots) };
  } catch (e) {
    log.error(`versions:list failed: ${e.message}`);
    return { ok: false, error: e.message, versions: [] };
  }
});

ipcMain.handle('versions:installed', () => versions.getInstalledVersions());
ipcMain.handle('versions:detailed', () => instances.listInstalledDetailed());
ipcMain.handle('versions:delete', (_e, id) => instances.deleteVersion(id));

// ---------------------------------------------------------------- fabric
ipcMain.handle('fabric:install', async (_e, { gameVersion, loaderVersion }) => {
  const onLog = (msg) => send('game:log', String(msg));
  const onProgress = (label, frac) => send('game:progress', { label, value: Math.max(0, Math.min(1, frac)) });
  try {
    const res = await fabric.install(String(gameVersion), String(loaderVersion || 'latest'), onLog, onProgress);
    return res;
  } catch (e) {
    log.error(`fabric install failed: ${e.message}`);
    onLog(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------- modrinth
ipcMain.handle('mods:search', async (_e, { query, gameVersion, limit, offset }) => {
  try {
    const res = await modrinth.searchPage(query, gameVersion, { limit: limit || 24, offset: offset || 0 });
    return { ok: true, results: res.hits.map((h) => ({
      projectId: h.project_id, slug: h.slug, title: h.title, description: h.description,
      author: h.author, downloads: h.downloads, iconUrl: h.icon_url || '', follows: h.follows
    })), total: res.total };
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }
});

ipcMain.handle('mods:top', async (_e, { gameVersion, limit, offset }) => {
  try {
    const cap = Math.min(limit || 100, modrinth.CATALOG_MAX);
    const facets = [['project_type:mod'], ['client_side:required']];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    const res = await modrinth.listCatalog(gameVersion || null, { limit: cap, index: 'downloads', facets });
    return { ok: true, results: res.items, total: res.total };
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }
});

ipcMain.handle('shaders:search', async (_e, { query, limit, offset, source }) => {
  try {
    if (source === 'curseforge') return await curseforge.searchShaders(query, limit || 50, offset || 0);
    return await modrinth.searchShaders(query, limit || 100, offset || 0);
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }
});

ipcMain.handle('shaders:top', async (_e, { limit, offset, source }) => {
  try {
    if (source === 'curseforge') return await curseforge.topShaders(limit || 50, offset || 0);
    return await modrinth.topShaders(limit || 100, offset || 0);
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }
});

ipcMain.handle('shaders:list', () => modrinth.listShaders());
ipcMain.handle('shaders:remove', (_e, name) => modrinth.removeShader(name));

ipcMain.handle('shaders:install', async (_e, { slug, source }) => {
  const onLog = (msg) => send('game:log', String(msg));
  const onProgress = (label, frac) => send('game:progress', { label, value: Math.max(0, Math.min(1, frac)) });
  try {
    if (source === 'curseforge') return await curseforge.installShader(String(slug), onLog, onProgress);
    return await modrinth.installShader(String(slug), onLog, onProgress);
  } catch (e) {
    log.error(`shader install failed: ${e.message}`);
    onLog(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// CurseForge catalog (needs an API key; graceful needsKey otherwise)
ipcMain.handle('cf:status', () => ({ ok: true, hasKey: curseforge.hasKey() }));

ipcMain.handle('cf:searchMods', async (_e, { query, gameVersion, offset }) => {
  return curseforge.searchMods(query, gameVersion || null, { offset: offset || 0 });
});

ipcMain.handle('cf:topMods', async (_e, { gameVersion, offset }) => {
  return curseforge.topMods(gameVersion || null, curseforge.PAGE_SIZE, offset || 0);
});

ipcMain.handle('cf:installMod', async (_e, { projectId, gameVersion, fabricId }) => {
  if (launching) return { ok: false, error: 'Wait until the game is not running' };
  const onLog = (msg) => send('game:log', String(msg));
  const onProgress = (label, frac) => send('game:progress', { label, value: Math.max(0, Math.min(1, frac)) });
  try {
    return await curseforge.installMod(String(projectId), gameVersion ? String(gameVersion) : null, String(fabricId), onLog, onProgress);
  } catch (e) {
    log.error(`cf mod install failed: ${e.message}`);
    onLog(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:install', async (_e, { slug, gameVersion, fabricId }) => {
  if (launching) return { ok: false, error: 'Wait until the game is not running' };
  const onLog = (msg) => send('game:log', String(msg));
  const onProgress = (label, frac) => send('game:progress', { label, value: Math.max(0, Math.min(1, frac)) });
  try {
    return await modrinth.installMod(String(slug), String(gameVersion), String(fabricId), onLog, onProgress);
  } catch (e) {
    log.error(`mod install failed: ${e.message}`);
    onLog(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:list', (_e, fabricId) => modrinth.listInstalled(fabricId));
ipcMain.handle('mods:remove', (_e, { fabricId, name }) => modrinth.removeMod(fabricId, name));

// ---------------------------------------------------------------- servers
ipcMain.handle('servers:list', () => instances.getServers());
ipcMain.handle('servers:add', (_e, server) => instances.addServer(server || {}));
ipcMain.handle('servers:remove', (_e, id) => instances.removeServer(id));

// ---------------------------------------------------------------- auth
ipcMain.handle('auth:active', () => auth.publicAccount(auth.getActiveAccount()));
ipcMain.handle('auth:accounts', () => auth.listAccountsPublic());

ipcMain.handle('auth:offline', (_e, name) => {
  const clean = String(name || 'Player').trim().slice(0, 16) || 'Player';
  store.settings.lastUsername = clean;
  store.saveSettings();
  const acc = auth.setOffline(clean);
  return auth.publicAccount(acc);
});

ipcMain.handle('auth:signout', () => {
  store.saveAccounts({ accounts: [], active: null });
  log.info('all accounts signed out');
  return { ok: true };
});

ipcMain.handle('auth:switch', (_e, uuid) => {
  const data = store.getAccounts();
  const target = data.accounts.find(a => a.uuid === uuid);
  if (!target) return { ok: false, error: 'No such account' };
  data.active = uuid;
  store.saveAccounts(data);
  log.info(`switched to ${target.name}`);
  return { ok: true, account: auth.publicAccount(target) };
});

let currentDeviceCode = null;
ipcMain.handle('auth:msa:start', async () => {
  try {
    const dc = await auth.deviceCodeStart();
    currentDeviceCode = dc;
    return { ok: true, userCode: dc.user_code, verificationUri: dc.verification_uri, interval: dc.interval || 5 };
  } catch (e) {
    log.error(`msa start failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('auth:msa:poll', async () => {
  try {
    if (!currentDeviceCode) return { done: true, error: 'No login in progress' };
    const account = await auth.deviceCodePoll(currentDeviceCode);
    if (account) {
      currentDeviceCode = null;
      return { done: true, account: auth.publicAccount(account) };
    }
    return { done: false };
  } catch (e) {
    currentDeviceCode = null;
    log.error(`msa poll failed: ${e.message}`);
    return { done: true, error: e.message };
  }
});

// ---------------------------------------------------------------- launch
function send(channel, data) {
  try { if (win && !win.isDestroyed()) win.webContents.send(channel, data); } catch (_) { /* closing */ }
}

ipcMain.handle('game:launch', async (_e, payload) => {
  if (launching) return { ok: false, error: 'Already launching' };
  launching = true;

  const onLog = (msg) => send('game:log', String(msg));
  const onProgress = (label, frac) => send('game:progress', { label, value: Math.max(0, Math.min(1, frac)) });

  try {
    let account = auth.getActiveAccount();
    if (!account) {
      const name = String(payload && payload.username || store.settings.lastUsername || 'Player').trim().slice(0, 16) || 'Player';
      account = auth.setOffline(name);
    }
    account = await auth.ensureFreshToken(account);

    const versionId = String(payload && payload.versionId || store.settings.lastVersionId || '');
    if (!versionId) throw new Error('No version selected');

    store.settings.lastVersionId = versionId;
    store.saveSettings();

    // Optional direct-join: payload.serverId refers to a saved server entry.
    let server = null;
    if (payload && payload.serverId) {
      server = instances.getServers().find(s => s.id === payload.serverId) || null;
    }

    const child = await launcher.launch({ versionId, auth: account, server, onLog, onProgress });
    currentChild = child;
    child.on('exit', () => {
      launching = false;
      currentChild = null;
      send('game:state', 'stopped');
    });
    send('game:state', 'running');
    log.info(`game launched: ${versionId} (pid ${child.pid})`);
    return { ok: true };
  } catch (e) {
    launching = false;
    currentChild = null;
    log.error(`launch failed: ${e.message}`);
    onLog(`ERROR: ${e.message}`);
    send('game:state', 'stopped');
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('game:stop', () => {
  if (currentChild) {
    const pid = currentChild.pid;
    try { launcher.killTree(pid); } catch (_) { /* already dead */ }
    log.info(`stopping game (pid ${pid})`);
    return { ok: true };
  }
  return { ok: false, error: 'Not running' };
});

ipcMain.handle('game:isRunning', () => launching);

ipcMain.handle('app:openGameFolder', () => {
  try {
    fs.mkdirSync(store.gameDir(), { recursive: true });
    shell.openPath(store.gameDir());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
