'use strict';

// Version manifest fetching + version JSON download/caching.
// - Manifest cache has a 30 min TTL and revalidates with ETag/If-None-Match
// - Stale cache doubles as offline fallback
// - Concurrent callers share one in-flight request

const fs = require('fs');
const path = require('path');

const store = require('./store');
const { fetchJson, download, HttpError } = require('./util');
const log = require('./logger').child('versions');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL = 30 * 60 * 1000; // 30 minutes
const cacheFile = path.join(store.appdata.root, 'manifest-cache.json');

let manifestCache = null;
let manifestFetchedAt = 0;
let inflight = null;

async function getManifest(force) {
  const cached = store.readJson(cacheFile, null);

  if (!manifestCache && cached && cached.versions) {
    manifestCache = cached;
    manifestFetchedAt = cached._fetchedAt || 0;
  }

  const fresh = manifestCache && (Date.now() - manifestFetchedAt) < MANIFEST_TTL;
  if (manifestCache && (fresh || force === false)) return manifestCache;

  if (!inflight) {
    inflight = (async () => {
      try {
        // Revalidate with ETag when we have one: 304 saves the full download.
        const headers = {};
        if (manifestCache && manifestCache._etag) headers['If-None-Match'] = manifestCache._etag;
        let etag = null;
        try {
          const m = await fetchJson(MANIFEST_URL, {
            headers,
            onResponse: (res) => { etag = res.headers.etag || null; }
          });
          m._fetchedAt = Date.now();
          if (etag) m._etag = etag;
          manifestCache = m;
          manifestFetchedAt = m._fetchedAt;
          store.writeJson(cacheFile, manifestCache);
          log.info(`manifest refreshed (${m.versions.length} versions)`);
        } catch (e) {
          if (e instanceof HttpError && e.status === 304 && manifestCache) {
            manifestFetchedAt = Date.now();
            manifestCache._fetchedAt = manifestFetchedAt;
            store.writeJson(cacheFile, manifestCache);
            log.debug('manifest unchanged (304)');
          } else {
            throw e;
          }
        }
      } catch (e) {
        // Network failed: fall back to stale cache if we have one.
        if (!manifestCache) {
          throw new Error(`Cannot fetch version manifest (${e.message}) and no cached copy exists`);
        }
        log.warn(`manifest fetch failed, using stale cache: ${e.message}`);
      } finally {
        inflight = null;
      }
      return manifestCache;
    })();
  }
  return inflight;
}

// Returns [{ id, type, url, releaseTime, releaseDate }...] filtered to
// releases (and optionally snapshots), newest first as Mojang provides.
async function listVersions(includeSnapshots = false) {
  const m = await getManifest();
  return m.versions
    .filter(v => includeSnapshots || v.type === 'release')
    .map(v => ({
      id: v.id,
      type: v.type,
      url: v.url,
      releaseTime: v.releaseTime,
      releaseDate: v.releaseTime ? v.releaseTime.slice(0, 10) : ''
    }));
}

async function getVersionJson(id) {
  // Basic safety: version ids become path segments.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid version id: ${id}`);

  const dir = path.join(store.appdata.versions, id);
  const file = path.join(dir, `${id}.json`);

  let local = store.readJson(file, null);
  if (local) return local;

  let entry = null;
  try {
    const manifest = await getManifest();
    entry = manifest.versions.find(v => v.id === id);
  } catch (e) {
    log.warn(`manifest unavailable while resolving ${id}: ${e.message}`);
  }

  if (!entry) throw new Error(`Version ${id} not found in manifest`);

  fs.mkdirSync(dir, { recursive: true });
  try {
    await download(entry.url, file);
    local = store.readJson(file, null);
    if (!local) throw new Error('downloaded file was not valid JSON');
    log.info(`version JSON downloaded: ${id}`);
    return local;
  } catch (e) {
    // Remove corrupt partial download so a retry starts clean.
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
    throw new Error(`Failed to download version ${id}: ${e.message}`);
  }
}

function getInstalledVersions() {
  if (!fs.existsSync(store.appdata.versions)) return [];
  return fs.readdirSync(store.appdata.versions).filter((name) => {
    try {
      const json = store.readJson(path.join(store.appdata.versions, name, `${name}.json`), null);
      return !!json;
    } catch (_) {
      return false;
    }
  });
}

module.exports = { getManifest, listVersions, getVersionJson, getInstalledVersions };
