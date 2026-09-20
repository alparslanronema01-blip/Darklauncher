'use strict';

// CurseForge for Studios API integration. Requires an x-api-key (free for
// launcher developers, issued via the CurseForge developer console). The key
// is read from (in order): settings.curseforgeKey, env CURSEFORGE_KEY,
// env CF_API_KEY. Without a key every call returns { ok:false, needsKey:true }
// so the UI can show a friendly setup hint instead of an error.
// Docs: https://docs.curseforge.com/rest-api/

const fs = require('fs');
const path = require('path');

const store = require('./store');
const log = require('./logger').child('curseforge');
const { download, fetchJson } = require('./util');

const API = 'https://api.curseforge.com';
const GAME_ID = 432; // Minecraft
// Class ids within Minecraft: mods / resource packs / shader-adjacent.
const CLASS_MOD = 6;
const CLASS_SHADER = 6552; // "Twitch integration"? No: 6552 = Shaders category
const PAGE_SIZE = 50; // CurseForge hard maximum
const CATALOG_MAX = 10000; // API-side cap: index + pageSize <= 10000

function apiKey() {
  return (store.settings && store.settings.curseforgeKey) ||
    process.env.CURSEFORGE_KEY || process.env.CF_API_KEY || '';
}

function hasKey() { return apiKey().length > 10; }

function disabled() {
  return { ok: false, needsKey: true, results: [], total: 0 };
}

async function call(route, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${API}${route}${qs ? '?' + qs : ''}`;
  const res = await fetchJson(url, { headers: { 'x-api-key': apiKey() } });
  return res;
}

// ------------------------------------------------------------ mapping

function mapHit(m) {
  return {
    projectId: String(m.id),
    slug: m.slug,
    title: m.name,
    description: m.summary || '',
    author: (m.authors && m.authors[0] && m.authors[0].name) || 'unknown',
    downloads: m.downloadCount || 0,
    iconUrl: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || '',
    // Source marker lets the UI decide how to install (mod jar vs shader zip).
    source: 'curseforge',
    classId: m.classId,
    links: m.links || {}
  };
}

function fileUrl(f) {
  // Download URL is on the file for most mods; some need the per-file endpoint.
  return f.downloadUrl || '';
}

// ------------------------------------------------------------ mods search

async function searchMods(query, gameVersion, { limit = PAGE_SIZE, offset = 0 } = {}) {
  if (!hasKey()) return disabled();
  const params = {
    gameId: GAME_ID,
    classId: CLASS_MOD,
    searchFilter: query || '',
    sortField: 2, // 2 = TotalDownloads (ModsSearchSortField)
    sortOrder: 'desc',
    index: Math.min(offset, CATALOG_MAX - PAGE_SIZE),
    pageSize: Math.min(limit, PAGE_SIZE)
  };
  if (gameVersion) params.gameVersion = gameVersion;
  try {
    const res = await call('/v1/mods/search', params);
    const data = res.data || [];
    return {
      ok: true,
      results: data.map(mapHit),
      total: (res.pagination && res.pagination.totalCount) || data.length
    };
  } catch (e) {
    log.warn(`search failed: ${e.message}`);
    return { ok: false, error: e.message, results: [], total: 0 };
  }
}

async function topMods(gameVersion, limit = PAGE_SIZE, offset = 0) {
  return searchMods('', gameVersion, { limit, offset });
}

// ------------------------------------------------------------ shaders

async function searchShaders(query, limit = PAGE_SIZE, offset = 0) {
  if (!hasKey()) return disabled();
  const params = {
    gameId: GAME_ID,
    classId: CLASS_SHADER,
    searchFilter: query || '',
    sortField: 2,
    sortOrder: 'desc',
    index: Math.min(offset, CATALOG_MAX - PAGE_SIZE),
    pageSize: Math.min(limit, PAGE_SIZE)
  };
  try {
    const res = await call('/v1/mods/search', params);
    const data = res.data || [];
    return { ok: true, results: data.map(mapHit), total: (res.pagination && res.pagination.totalCount) || data.length };
  } catch (e) {
    return { ok: false, error: e.message, results: [], total: 0 };
  }
}

async function topShaders(limit = PAGE_SIZE, offset = 0) {
  return searchShaders('', limit, offset);
}

// ------------------------------------------------------------ file resolution

// Latest file for a project, optionally filtered by game version.
async function latestFile(modId, gameVersion) {
  const res = await call(`/v1/mods/${modId}/files`, {
    gameVersion: gameVersion || '',
    pageSize: 50
  });
  const files = (res.data || []).filter(f => f.downloadUrl);
  if (!files.length) throw new Error(`No downloadable CurseForge file for project ${modId}`);
  files.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  // Prefer release files.
  const releases = files.filter(f => f.releaseType === 1);
  const pick = (releases.length ? releases : files)[0];
  return pick;
}

// ------------------------------------------------------------ install

// Install a mod file into an instance's mods folder. CF does not resolve
// dependencies anonymously, so only the primary jar is fetched.
async function installMod(projectId, gameVersion, fabricId, onLog, onProgress) {
  if (!hasKey()) return Object.assign(disabled(), { error: 'CurseForge API key missing' });
  const modsDir = path.join(store.appdata.game, 'instances', fabricId, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const f = await latestFile(projectId, gameVersion);
  const dest = path.join(modsDir, path.basename(f.fileName));
  onLog && onLog(`Downloading ${f.fileName} (CurseForge)...`);
  if (onProgress) onProgress(`CurseForge: ${f.fileName}`, 0.4);
  await download(fileUrl(f), dest);
  if (f.hashes && f.hashes.sha1) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
    if (h !== f.hashes.sha1) {
      try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
      throw new Error(`Checksum mismatch for ${f.fileName}`);
    }
  }
  if (onProgress) onProgress('Mod installed', 1);
  onLog && onLog(`Installed ${f.fileName}.`);
  log.info(`cf mod installed: ${f.fileName} -> ${fabricId}`);
  return { ok: true, files: [path.basename(f.fileName)] };
}

// Install a shader pack into the shared shaderpacks folder.
async function installShader(projectId, onLog, onProgress) {
  if (!hasKey()) return Object.assign(disabled(), { error: 'CurseForge API key missing' });
  const dir = path.join(store.appdata.game, 'shaderpacks');
  fs.mkdirSync(dir, { recursive: true });
  const f = await latestFile(projectId, null);
  const dest = path.join(dir, path.basename(f.fileName));
  onLog && onLog(`Downloading shader ${f.fileName} (CurseForge)...`);
  if (onProgress) onProgress(`Shader: ${f.fileName}`, 0.4);
  await download(fileUrl(f), dest);
  if (onProgress) onProgress('Shader installed', 1);
  onLog && onLog(`Shader installed: ${f.fileName}.`);
  log.info(`cf shader installed: ${f.fileName}`);
  return { ok: true, file: path.basename(f.fileName) };
}

// Reuse the shared list/remove helpers from the modrinth module so both
// sources manage the same physical folders.
const modrinth = require('./modrinth');
const listInstalled = modrinth.listInstalled;
const removeMod = modrinth.removeMod;
const listShaders = modrinth.listShaders;
const removeShader = modrinth.removeShader;

module.exports = {
  hasKey, searchMods, topMods, searchShaders, topShaders,
  installMod, installShader, listInstalled, removeMod, listShaders, removeShader,
  CATALOG_MAX, PAGE_SIZE
};
