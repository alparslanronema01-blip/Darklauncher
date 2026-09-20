'use strict';

// Modrinth integration: search mods, resolve version compatibility and
// install jars (with required dependencies) into an instance's mods folder.
// API docs: https://docs.modrinth.com

const fs = require('fs');
const path = require('path');

const store = require('./store');
const log = require('./logger').child('modrinth');
const { download, fetchJson } = require('./util');

const API = 'https://api.modrinth.com/v2';

// Catalog browsing limit per request. Modrinth supports offset paging far
// beyond any realistic catalog size (verified past 50k), so the only real
// ceiling here is sanity — 100k covers the whole catalog with room to grow.
const CATALOG_MAX = 100000;
const PAGE_SIZE = 100;

function instanceModsDir(fabricId) {
  return path.join(store.appdata.game, 'instances', fabricId, 'mods');
}

function shaderPacksDir() {
  return path.join(store.appdata.game, 'shaderpacks');
}

// ------------------------------------------------------------ search

// One raw page of search hits (offset-based pagination).
async function searchPage(query, gameVersion, { limit = PAGE_SIZE, offset = 0, index = 'relevance', facets } = {}) {
  const f = facets || [['project_type:mod']];
  if (gameVersion) f.push([`versions:${gameVersion}`]);
  const url = `${API}/search?query=${encodeURIComponent(query || '')}` +
    `&facets=${encodeURIComponent(JSON.stringify(f))}` +
    `&limit=${Math.min(limit, PAGE_SIZE)}&offset=${offset}&index=${index}`;
  const res = await fetchJson(url);
  return { hits: res.hits || [], total: res.total_hits || 0 };
}

async function searchMods(query, gameVersion, limit = 24) {
  const { hits } = await searchPage(query, gameVersion, { limit });
  return hits.map(mapHit);
}

function mapHit(h) {
  return {
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    iconUrl: h.icon_url || '',
    follows: h.follows
  };
}

// ------------------------------------------------------------ catalog (up to 10k)

// Fetch up to `limit` projects sorted by `index`. Pages Modrinth's 100-hit
// window with offset pagination until the cap, the reported total, or a
// short-page stop.
async function listCatalog(gameVersion, { limit = CATALOG_MAX, index = 'downloads', type = 'mod', facets } = {}) {
  const cap = Math.min(limit, CATALOG_MAX);
  const out = [];
  let total = Infinity;
  while (out.length < cap && out.length < total) {
    const page = await searchPage('', gameVersion, {
      limit: Math.min(PAGE_SIZE, cap - out.length),
      offset: out.length,
      index,
      facets: facets || [['project_type:' + type]]
    });
    total = page.total;
    if (!page.hits.length) break;
    out.push(...page.hits.map(mapHit));
  }
  log.info(`catalog: ${out.length} ${type}s (total on Modrinth: ${total})`);
  return { items: out, total };
}

async function topMods(gameVersion, limit = 100) {
  const facets = [['project_type:mod'], ['client_side:required']];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  const { items } = await listCatalog(gameVersion, { limit, index: 'downloads', facets });
  return items;
}

// ------------------------------------------------------------ shaders

// Shader packs live in the shared shaderpacks/ folder — Iris and OptiFine
// both read from there. No loader pinning needed.
async function shaderPage(query, { limit = 100, offset = 0, index = 'downloads' } = {}) {
  const facets = [['project_type:shader']];
  return searchPage(query, null, { limit, offset, index, facets });
}

async function searchShaders(query, limit = 100, offset = 0) {
  const { hits, total } = await shaderPage(query, { limit, offset, index: 'relevance' });
  return { ok: true, results: hits.map(mapHit), total };
}

async function topShaders(limit = 100, offset = 0) {
  const { hits, total } = await shaderPage('', { limit, offset, index: 'downloads' });
  return { ok: true, results: hits.map(mapHit), total };
}

// Install a shader pack zip into the shared shaderpacks folder.
async function installShader(slug, onLog, onProgress) {
  const dir = shaderPacksDir();
  fs.mkdirSync(dir, { recursive: true });
  const versions = await fetchJson(`${API}/project/${encodeURIComponent(slug)}/version`);
  if (!Array.isArray(versions) || !versions.length) throw new Error(`No downloadable file for shader "${slug}"`);
  const sorted = versions.slice().sort((a, b) => {
    const rank = (v) => (v.version_type === 'release' ? 0 : 1);
    return rank(a) - rank(b) || new Date(b.date_published) - new Date(a.date_published);
  });
  const file = ((sorted[0].files || []).find(f => f.primary) || (sorted[0].files || [])[0]);
  if (!file) throw new Error(`No file for shader ${slug}`);
  const dest = path.join(dir, file.filename);
  onLog && onLog(`Downloading shader ${file.filename}...`);
  if (onProgress) onProgress(`Shader: ${file.filename}`, 0.3);
  await download(file.url, dest);
  if (file.hashes && file.hashes.sha1) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
    if (h !== file.hashes.sha1) {
      try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
      throw new Error(`Checksum mismatch for ${file.filename}`);
    }
  }
  if (onProgress) onProgress('Shader installed', 1);
  onLog && onLog(`Shader installed: ${file.filename}. Select it in-game via Options > Video Settings > Shader Packs.`);
  log.info(`shader installed: ${file.filename}`);
  return { ok: true, file: file.filename };
}

function listShaders() {
  const dir = shaderPacksDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && (e.name.endsWith('.zip') || e.name.endsWith('.jar')))
    .map(e => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }));
}

function removeShader(name) {
  if (!/^[A-Za-z0-9._ -]+$/.test(name) || name.includes('..')) {
    return { ok: false, error: 'Invalid file name' };
  }
  try {
    fs.unlinkSync(path.join(shaderPacksDir(), name));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Pick the best Fabric-compatible file for a project on a game version.
async function resolveVersion(slugOrId, gameVersion) {
  const url = `${API}/project/${encodeURIComponent(slugOrId)}/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await fetchJson(url);
  if (!Array.isArray(versions) || !versions.length) {
    throw new Error(`No Fabric build of "${slugOrId}" for Minecraft ${gameVersion}`);
  }
  // Modrinth returns newest first; prefer release over beta/alpha.
  const sorted = versions.slice().sort((a, b) => {
    const rank = (v) => (v.version_type === 'release' ? 0 : 1);
    return rank(a) - rank(b) || new Date(b.date_published) - new Date(a.date_published);
  });
  const v = sorted[0];
  const file = (v.files || []).find(f => f.primary) || (v.files || [])[0];
  if (!file) throw new Error(`No downloadable file for ${slugOrId} ${v.version_number}`);
  return {
    versionId: v.id,
    versionNumber: v.version_number,
    dependencies: (v.dependencies || []).map(d => ({
      projectId: d.project_id,
      dependencyType: d.dependency_type // required | optional | incompatible
    })),
    file: { url: file.url, name: file.filename, size: file.size, sha1: file.hashes && file.hashes.sha1 }
  };
}

// ------------------------------------------------------------ install/uninstall

// Install a mod + required dependency tree. onLog/onProgress optional.
// Returns list of installed file names.
async function installMod(slug, gameVersion, fabricId, onLog, onProgress) {
  const modsDir = instanceModsDir(fabricId);
  fs.mkdirSync(modsDir, { recursive: true });

  const installed = new Set(listInstalled(fabricId).map(f => f.name));
  const installedFiles = [];
  const queue = [{ slug }];
  const seenProjects = new Set();
  let step = 0;

  while (queue.length) {
    const { slug: s } = queue.shift();
    if (seenProjects.has(s)) continue;
    seenProjects.add(s);

    const v = await resolveVersion(s, gameVersion);
    if (installed.has(v.file.name)) {
      onLog && onLog(`${v.file.name} already installed.`);
      continue;
    }

    onLog && onLog(`Downloading ${v.file.name} (${s})...`);
    step++;
    if (onProgress) onProgress(`Modrinth: ${v.file.name}`, step / (step + queue.length + 1));
    const dest = path.join(modsDir, v.file.name);
    await download(v.file.url, dest);

    // Verify sha1 when provided.
    if (v.file.sha1) {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
      if (hash !== v.file.sha1) {
        try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
        throw new Error(`Checksum mismatch for ${v.file.name}`);
      }
    }
    installed.add(v.file.name);
    installedFiles.push(v.file.name);

    // Required dependencies are installed automatically.
    for (const dep of v.dependencies) {
      if (dep.dependencyType === 'required' && dep.projectId) {
        queue.push({ slug: dep.projectId });
      }
    }
  }

  log.info(`installed ${installedFiles.length} mod file(s) into ${fabricId}`);
  onProgress && onProgress('Mods installed', 1);
  return { ok: true, files: installedFiles };
}

function listInstalled(fabricId) {
  const dir = instanceModsDir(fabricId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.jar'))
    .map(e => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    });
}

function removeMod(fabricId, name) {
  // Path safety: never allow traversal out of the mods dir.
  if (!/^[A-Za-z0-9._ -]+$/.test(name) || name.includes('..')) {
    return { ok: false, error: 'Invalid file name' };
  }
  const file = path.join(instanceModsDir(fabricId), name);
  try {
    fs.unlinkSync(file);
    log.info(`removed mod ${name} from ${fabricId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  searchMods, topMods, listCatalog, resolveVersion, installMod, listInstalled, removeMod,
  searchShaders, topShaders, installShader, listShaders, removeShader, shaderPacksDir,
  instanceModsDir, CATALOG_MAX
};
