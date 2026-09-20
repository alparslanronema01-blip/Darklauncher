'use strict';

// JSON persistence layer.
// - Atomic writes: write tmp -> fsync -> rename (survives crashes / power loss)
// - Corrupt file recovery: bad JSON is quarantined to .bak, defaults returned
// - Settings are deep-merged over DEFAULTS so new options appear after upgrades
// - Play history: profiles.json records lastPlayed/minutesPlayed per version
// In packaged Electron builds data lives in the OS userData dir; in dev it is
// portable in <project>/appdata.

const fs = require('fs');
const path = require('path');
const os = require('os');

const log = require('./logger').child('store');

let ROOT = path.join(__dirname, '..', 'appdata'); // portable default

const appdata = {
  root: ROOT,
  versions: path.join(ROOT, 'versions'),
  assets: path.join(ROOT, 'assets'),
  libraries: path.join(ROOT, 'libraries'),
  runtimes: path.join(ROOT, 'runtimes'),
  game: path.join(ROOT, 'game'),
  logs: path.join(ROOT, 'logs'),
  auth: path.join(ROOT, 'auth.json'),
  settings: path.join(ROOT, 'settings.json'),
  profiles: path.join(ROOT, 'profiles.json')
};

function repath(rootDir) {
  ROOT = rootDir;
  appdata.root = ROOT;
  appdata.versions = path.join(ROOT, 'versions');
  appdata.assets = path.join(ROOT, 'assets');
  appdata.libraries = path.join(ROOT, 'libraries');
  appdata.runtimes = path.join(ROOT, 'runtimes');
  appdata.game = path.join(ROOT, 'game');
  appdata.logs = path.join(ROOT, 'logs');
  appdata.auth = path.join(ROOT, 'auth.json');
  appdata.settings = path.join(ROOT, 'settings.json');
  appdata.profiles = path.join(ROOT, 'profiles.json');
}

function init(rootDir) {
  repath(rootDir);
  ensureDirs();
}

function ensureDirs() {
  for (const dir of [appdata.root, appdata.versions, appdata.assets, appdata.libraries, appdata.runtimes, appdata.game, appdata.logs]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  }
}

// ---------------------------------------------------------------- json io

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Quarantine the corrupt file so the user can inspect/recover it.
    try { fs.copyFileSync(file, file + '.bak'); } catch (_) { /* best effort */ }
    log.warn(`corrupt JSON recovered: ${path.basename(file)} (${e.message}); backup saved as .bak`);
    return fallback;
  }
}

// Atomic write: tmp file, flush to disk, rename over target.
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, payload);
  try {
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (_) { /* fsync best-effort (some filesystems) */ }
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // Windows rename-over-existing can race with AV scanners; fall back.
    try { fs.writeFileSync(file, payload); fs.unlinkSync(tmp); }
    catch (e) { log.error(`writeJson failed for ${path.basename(file)}: ${e.message}`); }
  }
}

ensureDirs();

// ---------------------------------------------------------------- settings

function systemRamMb() {
  try { return Math.round(os.totalmem() / (1024 * 1024)); } catch (_) { return 8192; }
}

// Cap so the JVM is never asked for more memory than the machine has.
function clampMemory(mb) {
  const ram = systemRamMb();
  return Math.max(1024, Math.min(mb || 4096, Math.max(1024, Math.floor(ram * 0.75))));
}

const DEFAULT_SETTINGS = {
  javaPath: '',
  memory: clampMemory(4096),
  width: 1280,
  height: 720,
  fullscreen: false,
  keepLauncherOpen: true,
  closeToTray: true,
  lastUsername: '',
  lastVersionId: ''
};

const settings = deepMerge(DEFAULT_SETTINGS, readJson(appdata.settings, {}));

function saveSettings() {
  writeJson(appdata.settings, settings);
}

// ---------------------------------------------------------------- accounts

function getAccounts() {
  return readJson(appdata.auth, { accounts: [], active: null });
}

function saveAccounts(data) {
  writeJson(appdata.auth, data);
}

// ---------------------------------------------------------------- play history

function getProfiles() {
  return readJson(appdata.profiles, { versions: {} });
}

function recordPlayStart(versionId) {
  const p = getProfiles();
  const v = p.versions[versionId] || {};
  v.lastPlayedAt = Date.now();
  v.lastSessionStart = Date.now();
  p.versions[versionId] = v;
  writeJson(appdata.profiles, p);
}

function recordPlayEnd(versionId) {
  const p = getProfiles();
  const v = p.versions[versionId];
  if (!v || !v.lastSessionStart) return;
  const minutes = Math.round((Date.now() - v.lastSessionStart) / 60000);
  v.minutesPlayed = (v.minutesPlayed || 0) + minutes;
  delete v.lastSessionStart;
  p.versions[versionId] = v;
  writeJson(appdata.profiles, p);
}

function lastPlayedAt(versionId) {
  const p = getProfiles();
  return (p.versions[versionId] && p.versions[versionId].lastPlayedAt) || null;
}

// ---------------------------------------------------------------- misc

// Working directory the game runs in (saves, screenshots, options.txt)
function gameDir() {
  fs.mkdirSync(appdata.game, { recursive: true });
  return appdata.game;
}

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObject(v) && isObject(base[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = {
  ROOT,
  appdata,
  settings,
  readJson,
  writeJson,
  clampMemory,
  systemRamMb,
  init,
  saveSettings,
  getAccounts,
  saveAccounts,
  getProfiles,
  recordPlayStart,
  recordPlayEnd,
  lastPlayedAt,
  gameDir
};
