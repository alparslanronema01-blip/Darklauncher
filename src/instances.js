'use strict';

// Instance utilities: saved multiplayer servers and installed-version
// management (disk usage, deletion, last-played stats).

const fs = require('fs');
const path = require('path');

const store = require('./store');
const log = require('./logger').child('instances');

// ---------------------------------------------------------------- servers

const SERVERS_DEFAULT = { servers: [] };

function serversFile() {
  return path.join(store.appdata.root, 'servers.json');
}

function getServers() {
  return store.readJson(serversFile(), SERVERS_DEFAULT).servers || [];
}

function saveServers(list) {
  store.writeJson(serversFile(), { servers: list });
}

// name + host required; port optional (default 25565).
function addServer({ name, host, port, versionId }) {
  const list = getServers();
  const clean = (s) => String(s || '').trim().slice(0, 64);
  const entry = {
    id: 'srv_' + Date.now().toString(36),
    name: clean(name) || clean(host) || 'Server',
    host: clean(host),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565,
    versionId: clean(versionId) || '',
    addedAt: Date.now()
  };
  if (!entry.host) return { ok: false, error: 'Host is required' };
  list.push(entry);
  saveServers(list);
  log.info(`server added: ${entry.name} (${entry.host}:${entry.port})`);
  return { ok: true, server: entry };
}

function removeServer(id) {
  const list = getServers().filter(s => s.id !== id);
  saveServers(list);
  return { ok: true };
}

// ---------------------------------------------------------------- version management

// Total bytes used by a version: its dir + libraries referenced by its JSON
// (approximated by scanning libraries dir when json unavailable).
function versionDiskUsage(id) {
  let total = 0;
  const dirSize = (d) => {
    let t = 0;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) t += dirSize(p);
        else t += fs.statSync(p).size;
      }
    } catch (_) { /* vanished */ }
    return t;
  };

  total += dirSize(path.join(store.appdata.versions, id));

  // Rough library share: count files touched by this version's JSON.
  try {
    const vjson = store.readJson(path.join(store.appdata.versions, id, `${id}.json`), null);
    if (vjson) {
      const seen = new Set();
      const addLib = (rel) => {
        if (!rel || seen.has(rel)) return;
        seen.add(rel);
        try { total += fs.statSync(path.join(store.appdata.libraries, rel)).size; } catch (_) { /* absent */ }
      };
      for (const lib of vjson.libraries || []) {
        if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) addLib(lib.downloads.artifact.path);
        if (lib.downloads && lib.downloads.classifiers) {
          for (const c of Object.values(lib.downloads.classifiers)) addLib(c.path);
        }
      }
      const client = vjson.downloads && vjson.downloads.client;
      if (client && client.size && !fs.existsSync(path.join(store.appdata.versions, id, `${id}.jar`))) {
        total += client.size; // not yet downloaded; skip silently otherwise
      }
    }
  } catch (_) { /* best effort */ }

  return total;
}

// Rich installed-version list: id, type, last played, minutes, disk usage.
function listInstalledDetailed() {
  const out = [];
  const root = store.appdata.versions;
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const id = name.name;
    const jsonPath = path.join(root, id, `${id}.json`);
    const vjson = store.readJson(jsonPath, null);
    if (!vjson) continue; // half-downloaded or foreign dir
    const jarExists = fs.existsSync(path.join(root, id, `${id}.jar`));
    out.push({
      id,
      inheritsFrom: vjson.inheritsFrom || null,
      isFabric: /^fabric-loader-/.test(id) || /fabric/i.test(vjson.mainClass || ''),
      complete: jarExists || !!vjson.inheritsFrom,
      lastPlayedAt: store.lastPlayedAt(id),
      minutesPlayed: (store.getProfiles().versions[id] || {}).minutesPlayed || 0,
      diskBytes: versionDiskUsage(id)
    });
  }
  return out.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

// Delete a version directory. Refuses ids with path-hostile characters.
function deleteVersion(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, error: 'Invalid version id' };
  const dir = path.join(store.appdata.versions, id);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Not installed' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log.info(`version deleted: ${id}`);
    return { ok: true };
  } catch (e) {
    log.error(`delete failed for ${id}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { getServers, addServer, removeServer, listInstalledDetailed, deleteVersion, versionDiskUsage };
