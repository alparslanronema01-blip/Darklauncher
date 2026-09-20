'use strict';

// Java management: scan system installs, or auto-download the official
// Mojang runtime matching the version's javaVersion.majorVersion.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const store = require('./store');
const { downloadWithRetry } = require('./util');

function isWindows() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }

function exeName() { return isWindows() ? 'javaw.exe' : 'java'; }

// Map Minecraft's required major Java version to Mojang runtime component names.
function runtimeComponent(major) {
  if (major >= 21) return 'java-runtime-delta';
  if (major >= 17) return 'java-runtime-gamma';
  if (major >= 11) return 'java-runtime-beta';
  return 'java-runtime-alpha';
}

// Prefer the exact component named by the version JSON (javaVersion.component);
// fall back to the major-version mapping for versions that don't name one.
function normalizeComponent(component, major) {
  if (typeof component === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(component)) return component;
  return runtimeComponent(major || 8);
}

// Vanilla-launcher products URL listing every runtime corpus/component.
// (The old /v1/packages/java-runtime.json path is long dead — HTTP 404.)
const RUNTIME_LIST_URL =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

// Corpus key in the runtime list for this machine ("windows-x64", "mac-os", ...).
function platformCorpus() {
  if (isWindows()) {
    if (process.arch === 'arm64') return 'windows-arm64';
    if (process.arch === 'ia32') return 'windows-x86';
    return 'windows-x64';
  }
  if (isMac()) return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (process.arch === 'arm64') return 'linux-arm64';
  if (process.arch === 'ia32') return 'linux-i386';
  return 'linux';
}

// Pick the newest fully-rolled-out manifest URL for a component.
// List shape: { corpus: { component: [entry, ...] } }, entries ordered
// oldest -> newest. Falls back to the 'gamecore' corpus, then to entries
// that are still rolling out. Returns the manifest URL or null.
function pickRuntimeEntry(all, corpus, component) {
  if (!all) return null;
  const corpora = [corpus, 'gamecore'].filter((c, i, a) => a.indexOf(c) === i);
  for (const c of corpora) {
    const arr = all[c] && all[c][component];
    if (!Array.isArray(arr) || !arr.length) continue;
    const withUrl = arr.filter((e) => e && e.manifest && e.manifest.url);
    if (!withUrl.length) continue;
    const ready = withUrl.filter((e) => !e.availability || e.availability.progress === 100);
    return (ready.length ? ready : withUrl).slice(-1)[0].manifest.url;
  }
  return null;
}

function javaExeVersion(exe) {
  // Parse "version 17.0.9" style output; returns [major, rest] or null.
  try {
    const out = execFileSync(exe, ['-version'], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    const all = out + '';
    const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(all);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    // Java 8 reports "1.8.0_xxx"
    const major = a === 1 ? parseInt(m[2] || '8', 10) : a;
    return { major, raw: all.trim().split(/\r?\n/)[0] };
  } catch (_) {
    return null;
  }
}

// Verify a runtime dir actually contains a working java with the right major version.
function runtimeIsUsable(rtDir, major) {
  const exe = path.join(rtDir, 'bin', exeName());
  if (!fs.existsSync(exe)) return false;
  const info = javaExeVersion(exe);
  return !!info && info.major >= major;
}

function scanSystemRuntimes() {
  const found = [];
  const exe = exeName();
  const bases = isWindows() ? [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    path.join(os.homedir(), '.jdks'),
    path.join(os.homedir(), 'scoop', 'apps', 'java')
  ] : isMac() ? [
    '/Library/Java/JavaVirtualMachines'
  ] : [
    '/usr/lib/jvm',
    '/opt/java',
    path.join(os.homedir(), '.jdks')
  ];

  for (const base of bases) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const sub = path.join(base, e.name);
      const candidates = e.isDirectory()
        ? [path.join(sub, 'bin', exe), path.join(sub, 'Contents', 'Home', 'bin', exe)]
        : [sub];
      for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        const info = javaExeVersion(c);
        if (info) found.push({ path: c, major: info.major });
        break; // one candidate per subdir
      }
    }
  }

  // Also honor JAVA_HOME and PATH java as a last resort.
  return found;
}

function manualJavaCandidates() {
  const exe = exeName();
  const out = [];
  if (process.env.JAVA_HOME) out.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  if (isMac()) out.push('/usr/bin/java');
  return out.filter((p) => fs.existsSync(p));
}

// Find best local java >= major. Returns exe path or null.
function findLocalJava(major) {
  if (store.settings.javaPath) {
    const p = store.settings.javaPath;
    if (fs.existsSync(p)) {
      const info = javaExeVersion(p);
      if (info && (!major || info.major >= major)) return p;
    }
  }
  const locals = scanSystemRuntimes();
  locals.sort((a, b) => b.major - a.major);
  const ok = locals.find(l => l.major >= major);
  if (ok) return ok.path;

  for (const c of manualJavaCandidates()) {
    const info = javaExeVersion(c);
    if (info && (!major || info.major >= major)) return c;
  }
  return null;
}

// Download + extract a Mojang runtime. Returns java exe path.
async function ensureMojangRuntime(major, onProgress, onLog, requestedComponent) {
  const component = normalizeComponent(requestedComponent, major || 8);
  const platform = isWindows() ? (process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64')
    : isMac() ? 'mac-os' : (process.arch === 'arm64' ? 'linux-arm64' : 'linux');
  const rtRoot = path.join(store.appdata.runtimes, component);

  // Already installed and usable?
  if (runtimeIsUsable(rtRoot, major || 8)) {
    return path.join(rtRoot, 'bin', exeName());
  }

  onLog && onLog(`No Java ${major} found. Downloading Mojang runtime (${component})...`);

  // The all-runtimes list lives at the vanilla launcher's products URL.
  let allRt;
  try {
    allRt = await require('./util').fetchJson(RUNTIME_LIST_URL);
  } catch (e) {
    throw new Error(`Cannot fetch Java runtime list: ${e.message}`);
  }

  const corpus = platformCorpus();
  const manifestUrl = pickRuntimeEntry(allRt, corpus, component);
  if (!manifestUrl) throw new Error(`No ${component} runtime available for ${corpus}`);

  const jrm = await require('./util').fetchJson(manifestUrl);
  const files = jrm && jrm.files ? Object.entries(jrm.files) : null;
  if (!files || !files.length) {
    throw new Error(`Runtime manifest ${component} had no files`);
  }

  fs.mkdirSync(rtRoot, { recursive: true });
  const fileEntries = files.filter(([, f]) => f.type === 'file' && f.downloads && f.downloads.raw);
  let done = 0;
  for (const [rel, f] of fileEntries) {
    done++;
    const dest = path.join(rtRoot, rel);
    if (fs.existsSync(dest) && f.downloads.raw.sha1) {
      try {
        const crypto = require('crypto');
        const h = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
        if (h === f.downloads.raw.sha1) {
          onProgress && onProgress(`Java files ${done}/${fileEntries.length}`, done / fileEntries.length);
          continue;
        }
      } catch (_) { /* redownload */ }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await downloadWithRetry(f.downloads.raw.url, dest);
    onProgress && onProgress(`Java files ${done}/${fileEntries.length}`, done / fileEntries.length);
  }

  // Executable bit on unix
  if (!isWindows()) {
    try {
      fs.chmodSync(path.join(rtRoot, 'bin', 'java'), 0o755);
    } catch (_) { /* best effort */ }
  }

  const exe = path.join(rtRoot, 'bin', exeName());
  if (!fs.existsSync(exe)) throw new Error('Runtime installed but java executable missing');
  onLog && onLog(`Java runtime ready: ${component}`);
  return exe;
}

// Public API: resolve a java exe for the given required major version.
async function resolveJava(requiredMajor, onProgress, onLog, component) {
  const major = requiredMajor || 8;
  const local = findLocalJava(major);
  if (local) return { exe: local, downloaded: false };
  const exe = await ensureMojangRuntime(major, onProgress, onLog, component);
  return { exe, downloaded: true };
}

module.exports = {
  resolveJava,
  findLocalJava,
  scanSystemRuntimes,
  javaExeVersion,
  runtimeComponent,
  normalizeComponent,
  platformCorpus,
  pickRuntimeEntry,
  runtimeIsUsable
};
