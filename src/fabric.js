'use strict';

// Fabric loader installation.
// Generates a version JSON that inheritsFrom the vanilla version, downloads
// Fabric's libraries from maven.fabricmc.net and stores the profile under
// versions/<id>/. From then on the modded version appears in the version
// list and launches exactly like a native one.

const fs = require('fs');
const path = require('path');

const store = require('./store');
const log = require('./logger').child('fabric');
const { download, fetchJson } = require('./util');
const { getVersionJson } = require('./versions');

const META = 'https://meta.fabricmc.net/v2';

// Full Fabric version id, e.g. "fabric-loader-0.16.5-1.21.4"
function versionId(loader, game) {
  return `fabric-loader-${loader}-${game}`;
}

// The launcher derives the client jar path from `jar`/id; fabric versions
// reuse the vanilla jar, which inheritsFrom already handles.
async function install(gameVersion, loaderVersion, onLog, onProgress) {
  onLog && onLog(`Fetching Fabric loader profiles...`);
  let loaders = null;
  try {
    loaders = await fetchJson(`${META}/versions/loader/${gameVersion}`);
  } catch (e) {
    throw new Error(`Cannot reach Fabric meta: ${e.message}`);
  }

  const entry = (loaderVersion && loaderVersion !== 'latest'
    ? loaders.find(l => l.loader && l.loader.version === loaderVersion)
    : null) || (loaders.length ? loaders[0] : null);
  if (!entry || !entry.loader) throw new Error(`No Fabric loader found for ${gameVersion}`);

  // Resolve 'latest' (or any alias) to the concrete loader version BEFORE
  // building the id, so profiles are named fabric-loader-0.19.5-1.21.1,
  // never fabric-loader-latest-1.21.1.
  const loader = entry.loader;                 // { version, stable }
  const resolvedLoader = loader.version;
  const id = versionId(resolvedLoader, gameVersion);
  const dir = path.join(store.appdata.versions, id);
  const file = path.join(dir, `${id}.json`);

  if (fs.existsSync(file)) {
    onLog && onLog(`Fabric ${resolvedLoader} for ${gameVersion} is already installed.`);
    return { ok: true, id, alreadyInstalled: true };
  }
  // Fabric meta v2: launcherMeta is a SIBLING of loader on the entry, with
  //   mainClass: { client, server }  (older metas used a plain string)
  //   libraries: { common: [...], client: [...], server: [...], development: [...] }
  const launchMeta = entry.launcherMeta || loader.launcherMeta || {};
  const mc = launchMeta.mainClass;
  const mainClass = typeof mc === 'string' ? mc : (mc && mc.client);
  if (!mainClass) throw new Error('Fabric meta did not provide a client mainClass');

  const groups = launchMeta.libraries;
  const libRows = [
    ...((groups && (groups.common || [])) || (Array.isArray(groups) ? groups : [])),
    ...((groups && groups.client) || []),
    ...(entry.intermediary && entry.intermediary.maven ? [{ name: entry.intermediary.maven, url: 'https://maven.fabricmc.net/' }] : [])
  ];

  log.info(`installing fabric ${loader.version} for ${gameVersion} (${libRows.length} libraries)`);

  // Vanilla parent must exist locally before launch.
  onLog && onLog(`Ensuring vanilla ${gameVersion} is available...`);
  await getVersionJson(gameVersion);

  // Build our own profile JSON from Fabric's launch metadata.
  const profile = {
    id,
    inheritsFrom: gameVersion,
    releaseTime: new Date().toISOString(),
    time: new Date().toISOString(),
    type: 'release',
    mainClass,
    // Fabric injects its own JVM tweak; keep it simple, our launcher adds the rest.
    arguments: {
      game: [],
      jvm: ['-DFabricMcEmulator=net.fabricmc.loader.impl.game.minecraft.Hooks']
    },
    libraries: libRows.map((lib) => ({
      name: lib.name,
      url: lib.url || 'https://maven.fabricmc.net/'
    })),
    // Vanilla jar is reused via inheritsFrom; nothing to download here.
    jar: gameVersion
  };

  fs.mkdirSync(dir, { recursive: true });
  store.writeJson(file, profile);

  // Download Fabric libraries (tiny: loader + intermediary + a handful).
  let done = 0;
  for (const lib of profile.libraries) {
    const rel = mavenRelPath(lib.name);
    const dest = path.join(store.appdata.libraries, rel);
    done++;
    if (onProgress) onProgress(`Fabric ${path.basename(rel)}`, done / (profile.libraries.length + 1));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const base = lib.url.endsWith('/') ? lib.url : lib.url + '/';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await download(base + rel, dest);
    } catch (e) {
      log.warn(`fabric lib failed: ${rel}: ${e.message}`);
      throw new Error(`Failed to download ${rel}: ${e.message}`);
    }
  }

  onProgress && onProgress('Fabric installed', 1);
  onLog && onLog(`Fabric ${resolvedLoader} installed as "${id}". Pick it in the version list!`);
  log.info(`fabric profile written: ${id}`);
  return { ok: true, id };
}

// "net.fabricmc:fabric-loader:0.16.5" -> net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar
function mavenRelPath(name) {
  const parts = name.split(':');
  if (parts.length < 3) throw new Error(`Bad maven name: ${name}`);
  const [group, artifact, version] = parts;
  const fileName = `${artifact}-${version}.jar`;
  return path.join(...group.split('.'), artifact, version, fileName);
}

// Available game versions for which Fabric has a loader.
async function supportedGameVersions() {
  const m = await fetchJson(`${META}/versions/loader`);
  // Response shape: [{ loader: {...}, intermediary: {...}, launcherMeta: {...} }...] isn't
  // per-game; the per-game endpoint is expensive for all. Use loader profile list instead.
  return m; // caller picks game version manually; we validate on install
}

module.exports = { install, versionId, mavenRelPath };
