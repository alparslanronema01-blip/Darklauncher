'use strict';

// Downloads everything a version needs (libraries, assets, client) and launches the game.
// Progress is reported in weighted phases so the UI bar moves smoothly and
// never jumps: files 0-45%, assets 45-80%, java 80-90%, launch 90-100%.

const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const store = require('./store');
const log = require('./logger').child('launcher');
const { download, downloadWithRetry, pool, isRetryable } = require('./util');
const { getVersionJson } = require('./versions');
const java = require('./java');

const ASSET_CONCURRENCY = 16;
const LIB_CONCURRENCY = 6;

// Weighted phase windows for the smooth progress bar.
const PHASE = { FILES: [0.0, 0.45], ASSETS: [0.45, 0.8], JAVA: [0.8, 0.9], START: [0.9, 1.0] };

function inWindow(label, frac, win) {
  const [lo, hi] = win;
  return { label, value: lo + Math.max(0, Math.min(1, frac)) * (hi - lo) };
}

function isWindows() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }

function sha1(file) {
  try {
    const data = fs.readFileSync(file);
    return crypto.createHash('sha1').update(data).digest('hex');
  } catch (_) {
    return null;
  }
}

// Maven name "group:artifact:version[:classifier][@ext]" -> relative path
function libRelPath(mavenName, ext) {
  const [coords, classifierOverride] = mavenName.split('@');
  const parts = coords.split(':');
  if (parts.length < 3) throw new Error(`Bad maven name: ${mavenName}`);
  const classifier = parts[3] || classifierOverride || '';
  const fileName = `${parts[1]}-${parts[2]}${classifier ? '-' + classifier : ''}.${ext || 'jar'}`;
  return path.join(...parts[0].split('.'), parts[1], parts[2], fileName);
}

function currentOs() {
  return isWindows() ? 'windows' : isMac() ? 'osx' : 'linux';
}

// Mojang rule evaluator (os + features)
function rulesAllow(rules, features) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let osOk = true;
    if (rule.os) {
      if (rule.os.name) osOk = osOk && rule.os.name === currentOs();
      if (rule.os.arch) osOk = osOk && (rule.os.arch === process.arch || (rule.os.arch === 'x86' && process.arch === 'ia32'));
    }
    let featOk = true;
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (features[k] !== v) { featOk = false; break; }
      }
    }
    if (osOk && featOk) allowed = rule.action === 'allow';
  }
  return allowed;
}

function libNativesClassifier(lib) {
  if (!lib || !lib.natives) return null;
  return lib.natives[currentOs()] || null;
}

// ---------------------------------------------------------------- downloads

async function ensureClientAndLibraries(vjson, onProgress, onLog) {
  const jobs = [];
  const clientDir = path.join(store.appdata.versions, vjson.id);
  fs.mkdirSync(clientDir, { recursive: true });

  for (const lib of vjson.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const dl = lib.downloads && lib.downloads.artifact;
    if (dl && dl.url) {
      jobs.push({ url: dl.url, dest: path.join(store.appdata.libraries, dl.path || libRelPath(lib.name, 'jar')), sha1: dl.sha1, size: dl.size || 0, name: lib.name });
    } else if (!dl && lib.url) {
      // Legacy manifest entry (no downloads metadata): maven URL + name only.
      const legacyCls = libNativesClassifier(lib);
      jobs.push({
        url: lib.url,
        dest: path.join(store.appdata.libraries, libRelPath(legacyCls ? `${lib.name}:${legacyCls}` : lib.name, 'jar')),
        sha1: null,
        size: 0,
        name: lib.name
      });
    }
    const cls = libNativesClassifier(lib);
    if (cls && lib.downloads && lib.downloads.classifiers) {
      const nDl = lib.downloads.classifiers[cls];
      if (nDl && nDl.url) {
        jobs.push({ url: nDl.url, dest: path.join(store.appdata.libraries, nDl.path || libRelPath(`${lib.name}:${cls}`, 'jar')), sha1: nDl.sha1, size: nDl.size || 0, name: lib.name + ' (natives)' });
      }
    }
  }

  const client = vjson.downloads && vjson.downloads.client;
  const clientJar = path.join(clientDir, `${vjson.id}.jar`);
  if (client && client.url) {
    jobs.push({ url: client.url, dest: clientJar, sha1: client.sha1, size: client.size || 0, name: 'client.jar' });
  }

  let validCount = 0;
  let downloadedCount = 0;
  const totalJobs = jobs.length;

  await pool(jobs, LIB_CONCURRENCY, async (job) => {    let valid = false;
      if (fs.existsSync(job.dest)) {
        valid = job.sha1 ? sha1(job.dest) === job.sha1 : fs.statSync(job.dest).size > 0;
      }
      if (valid) {
        validCount++;
        return;
      }
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      await downloadWithRetry(job.url, job.dest, (frac) => {
        if (onProgress) onProgress(`Downloading ${job.name}`, (downloadedCount + frac) / totalJobs);
      });
      downloadedCount++;
      if (job.sha1 && sha1(job.dest) !== job.sha1) {
        throw new Error(`Checksum mismatch: ${job.dest}`);
      }
    }, () => {
      if (onProgress) onProgress(`Checking files...`, (validCount + downloadedCount) / totalJobs);
    });

  onLog && onLog(`Libraries ready (${downloadedCount} downloaded, ${validCount} cached).`);
  onProgress && onProgress(`All files ready`, 1);
}

// ---- helpers used by launch() below (see bottom of file)

async function ensureAssets(vjson, onProgress, onLog) {
  const idx = vjson.assetIndex;
  if (!idx) return;
  const indexesDir = path.join(store.appdata.assets, 'indexes');
  fs.mkdirSync(indexesDir, { recursive: true });
  const idxPath = path.join(indexesDir, `${idx.id}.json`);
  if (!fs.existsSync(idxPath) || (idx.sha1 && sha1(idxPath) !== idx.sha1)) {
    await downloadWithRetry(idx.url, idxPath);
  }
  const index = store.readJson(idxPath, null);
  if (!index || !index.objects) return;

  const objectsDir = path.join(store.appdata.assets, 'objects');
  const virtualDir = path.join(store.appdata.assets, 'virtual', idx.id);
  const entries = Object.entries(index.objects);

  // Filter out assets already on disk; hash check only on suspiciously small files.
  let todo = [];
  for (const [name, obj] of entries) {
    const prefix = obj.hash.slice(0, 2);
    const dest = path.join(objectsDir, prefix, obj.hash);
    let have = false;
    try {
      const st = fs.statSync(dest);
      have = st.isFile() && (st.size > 0) && (st.size === obj.size || st.size > 4096 || !obj.size);
    } catch (_) { /* missing */ }
    if (!have) todo.push({ name, obj, dest });
  }

  onLog && onLog(`Assets: ${entries.length - todo.length} cached, ${todo.length} to download.`);
  if (!todo.length) {
    onProgress && onProgress('Assets ready', PHASE.ASSETS[1]);
    return;
  }

  let done = 0;
  let failed = 0;
  await pool(todo, ASSET_CONCURRENCY, async (item) => {
    const prefix = item.obj.hash.slice(0, 2);
    const url = `https://resources.download.minecraft.net/${prefix}/${item.obj.hash}`;
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    try {
      await downloadWithRetry(url, item.dest);
      if (item.obj.size && fs.statSync(item.dest).size !== item.obj.size) {
        throw new Error('size mismatch');
      }
    } catch (e) {
      failed++;
      try { fs.unlinkSync(item.dest); } catch (_) { /* ignore */ }
      if (failed <= 3) log.warn(`asset failed: ${item.name}: ${e.message}`);
      return;
    }
    done++;
    if (onProgress && (done % 20 === 0 || done === todo.length)) {
      onProgress(`Assets ${done}/${todo.length}`, done / todo.length);
    }
  });

  // Virtual / legacy resource layout
  if (index.virtual || index.map_to_resources) {
    const already = new Set();
    for (const item of todo) {
      const src = item.dest;
      if (!fs.existsSync(src)) continue;
      const target = index.map_to_resources
        ? path.join(store.gameDir(), 'resources', item.name)
        : path.join(virtualDir, item.name);
      if (already.has(target)) continue;
      already.add(target);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try { fs.copyFileSync(src, target); } catch (_) { /* source missing */ }
      }
    }
  }

  if (failed > 0) {
    onLog && onLog(`WARNING: ${failed} assets failed to download (game will still try to run).`);
  }
  onProgress && onProgress('Assets ready', PHASE.ASSETS[1]);
}

function extractNatives(vjson) {
  const dir = path.join(store.appdata.versions, vjson.id, 'natives');
  fs.mkdirSync(dir, { recursive: true });
  let extracted = 0;

  for (const lib of vjson.libraries || []) {
    if (!lib.natives || !rulesAllow(lib.rules)) continue;
    const cls = lib.natives[currentOs()];
    if (!cls) continue;
    const nDl = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
    const jarFile = nDl
      ? path.join(store.appdata.libraries, nDl.path || libRelPath(`${lib.name}:${cls}`, 'jar'))
      : path.join(store.appdata.libraries, libRelPath(`${lib.name}:${cls}`, 'jar'));
    if (!fs.existsSync(jarFile)) continue;
    const buf = fs.readFileSync(jarFile);

    // Locate End Of Central Directory record
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) continue;

    const count = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // central dir signature
      const method = buf.readUInt16LE(ptr + 10);
      const compSize = buf.readUInt32LE(ptr + 20);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const localOff = buf.readUInt32LE(ptr + 42);
      const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
      ptr += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/') || !/\.(dll|so|dylib|jnilib)$/i.test(name)) continue;
      if (name.includes('META-INF')) continue;

      // Resolve local header to find compressed data
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else continue;
      fs.writeFileSync(path.join(dir, path.basename(name)), data);
      extracted++;
    }
  }

  log.info(`natives: ${extracted} files extracted to ${dir}`);
  return dir;
}

// Kill the whole process tree so Minecraft's child processes die too.
function killTree(pid) {
  if (isWindows()) {
    exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
  }
}

// ---------------------------------------------------------------- versions (with inheritsFrom merge)

async function resolveVersionJson(id) {
  const vjson = await getVersionJson(id);
  if (!vjson) throw new Error(`Could not load version JSON for ${id}`);
  if (!vjson.inheritsFrom) return vjson;

  const parent = await getVersionJson(vjson.inheritsFrom);
  if (!parent) throw new Error(`Missing parent version ${vjson.inheritsFrom}`);

  const merged = JSON.parse(JSON.stringify(parent));
  merged.id = vjson.id;
  merged.jar = vjson.jar || parent.jar || parent.id;
  merged.mainClass = vjson.mainClass || parent.mainClass;
  merged.assets = vjson.assets || parent.assets;
  merged.assetIndex = vjson.assetIndex || parent.assetIndex;
  merged.libraries = (parent.libraries || []).concat(vjson.libraries || []);
  if (parent.arguments && vjson.arguments) {
    merged.arguments = {
      game: (parent.arguments.game || []).concat(vjson.arguments.game || []),
      jvm: (parent.arguments.jvm || []).concat(vjson.arguments.jvm || [])
    };
  } else if (vjson.arguments) {
    merged.arguments = vjson.arguments;
  }
  merged.minecraftArguments = vjson.minecraftArguments || parent.minecraftArguments;
  merged.downloads = vjson.downloads || parent.downloads;
  merged.natives = vjson.natives || parent.natives;
  return merged;
}

// ---------------------------------------------------------------- args

function fillTemplate(str, map) {
  let s = str;
  for (const [k, v] of Object.entries(map)) {
    s = s.split('${' + k + '}').join(v);
  }
  return s;
}

function flattenArgList(list, features, map) {
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push(fillTemplate(item, map));
    } else if (item && rulesAllow(item.rules, features)) {
      const values = Array.isArray(item.value) ? item.value : [item.value];
      for (const v of values) out.push(fillTemplate(String(v), map));
    }
  }
  return out;
}

function buildLaunchConfig(vjson, opts) {
  const sep = isWindows() ? ';' : ':';
  const auth = opts.auth || { name: 'Player', uuid: '0', accessToken: '0', userType: 'msa' };

  const features = {
    is_demo_user: false,
    has_custom_res: true,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };

  // Classpath: every allowed artifact library + the client jar.
  const cp = [];
  const seen = new Set();
  for (const lib of vjson.libraries || []) {
    if (!rulesAllow(lib.rules, features)) continue;
    const dl = lib.downloads && lib.downloads.artifact;
    if (dl && dl.path) {
      const p = path.join(store.appdata.libraries, dl.path);
      if (!seen.has(p)) { seen.add(p); cp.push(p); }
    } else if (!dl && lib.url) {
      const p = path.join(store.appdata.libraries, libRelPath(lib.name, 'jar'));
      if (!seen.has(p)) { seen.add(p); cp.push(p); }
    }
  }
  const jarName = vjson.jar || vjson.id;
  cp.push(path.join(store.appdata.versions, jarName, `${jarName}.jar`));

  const nativesDir = path.join(store.appdata.versions, vjson.id, 'natives');

  const map = {
    auth_player_name: auth.name,
    auth_uuid: auth.uuid,
    auth_access_token: auth.accessToken,
    auth_session: auth.accessToken,
    auth_xuid: auth.xuid || '0',
    clientid: auth.clientId || 'darklauncher',
    user_type: auth.userType || 'msa',
    version_name: vjson.id,
    assets_index_name: vjson.assets,
    assets_root: store.appdata.assets,
    game_directory: store.gameDir(),
    game_assets: fs.existsSync(path.join(store.appdata.assets, 'virtual', vjson.assets || '')) && vjson.assets
      ? path.join(store.appdata.assets, 'virtual', vjson.assets)
      : store.appdata.assets,
    launcher_name: 'Darklauncher',
    launcher_version: '1.0.0',
    natives_directory: nativesDir,
    classpath: cp.join(sep),
    library_directory: store.appdata.libraries,
    classpath_separator: sep,
    resolution_width: String(store.settings.width),
    resolution_height: String(store.settings.height),
    user_properties: '{}',
    quick_play_path: ''
  };

  // JVM arguments
  let jvmArgs;
  if (vjson.arguments && vjson.arguments.jvm) {
    jvmArgs = flattenArgList(vjson.arguments.jvm, features, map);
  } else {
    jvmArgs = fillTemplate(
      '-Djava.library.path=${natives_directory} -Dminecraft.launcher.brand=${launcher_name} -Dminecraft.launcher.version=${launcher_version} -cp ${classpath}',
      map
    ).split(' ');
  }

  const memory = store.clampMemory(store.settings.memory);
  const userJvm = [
    `-Xmx${memory}M`,
    '-Xms512M',
    '-XX:+UseG1GC',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50'
  ];

  // Game arguments
  let gameArgs;
  if (vjson.arguments && vjson.arguments.game) {
    gameArgs = flattenArgList(vjson.arguments.game, features, map);
  } else if (vjson.minecraftArguments) {
    gameArgs = vjson.minecraftArguments.split(' ').map((t) => fillTemplate(t, map));
  } else {
    throw new Error('Version JSON has neither arguments.game nor minecraftArguments');
  }

  if (store.settings.fullscreen) gameArgs.push('--fullscreen');

  const mainClass = vjson.mainClass;
  if (!mainClass) throw new Error('Version JSON has no mainClass');

  return {
    args: [...userJvm, ...jvmArgs, mainClass, ...gameArgs],
    cwd: store.gameDir(),
    nativesDir
  };
}

// ---------------------------------------------------------------- entry

async function launch(opts) {
  const { versionId, auth, onLog, onProgress } = opts;
  const say = (msg) => { log.info(msg); onLog && onLog(log.mask(msg)); };

  say(`Preparing version ${versionId}...`);
  const vjson = await resolveVersionJson(versionId);

  say('Checking files...');
  // Phase-map the inner callbacks into the weighted progress windows.
  const fileProgress = onProgress && ((label, frac) => onProgress(label, inWindow(label, frac, PHASE.FILES).value));
  await ensureClientAndLibraries(vjson, fileProgress, onLog);
  const assetProgress = onProgress && ((label, frac) => onProgress(label, inWindow(label, frac, PHASE.ASSETS).value));
  await ensureAssets(vjson, assetProgress, onLog);

  say('Extracting natives...');
  extractNatives(vjson);

  const requiredJava = vjson.javaVersion && vjson.javaVersion.majorVersion;
  const javaComponent = vjson.javaVersion && vjson.javaVersion.component;
  const javaProgress = onProgress && ((label, frac) => onProgress(label, inWindow(label, frac, PHASE.JAVA).value));
  const { exe: javaPath, downloaded: javaDownloaded } = await java.resolveJava(requiredJava, javaProgress, say, javaComponent);
  if (javaDownloaded) say('Downloaded the official Java runtime.');

  const cfg = buildLaunchConfig(vjson, { auth });
  fs.mkdirSync(cfg.cwd, { recursive: true });

  // Direct server join: vanilla supports --server/--port on the game args.
  if (opts.server && opts.server.host) {
    cfg.args.push('--server', String(opts.server.host));
    if (opts.server.port && opts.server.port !== 25565) cfg.args.push('--port', String(opts.server.port));
    say(`Will join server ${opts.server.host}:${opts.server.port || 25565}`);
  }

  say(`Starting with ${javaPath}`);
  onProgress && onProgress('Starting Minecraft...', PHASE.START[1]);

  // Detached + own process group so Stop can kill the whole tree.
  const child = spawn(javaPath, cfg.args, {
    cwd: cfg.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    detached: !isWindows()
  });

  child.stdout.on('data', (d) => onLog && onLog(log.mask(d.toString().trimEnd())));
  child.stderr.on('data', (d) => onLog && onLog(log.mask(d.toString().trimEnd())));
  child.on('error', (err) => onLog && onLog(`Failed to start: ${err.message}`));
  child.on('exit', (code) => {
    store.recordPlayEnd(versionId);
    say(`Minecraft exited with code ${code}`);
  });
  store.recordPlayStart(versionId);

  return child;
}

function offlineUuid(name) {
  return crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest('hex');
}

module.exports = { launch, extractNatives, buildLaunchConfig, findJava: java.findLocalJava, offlineUuid, rulesAllow, killTree };
