'use strict';

// Generates preview/index.html from the REAL renderer files
// (src/renderer/index.html + style.css), replacing renderer.js with a
// mocked window.darklauncher API so the UI can be reviewed in a browser.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'src', 'renderer', 'index.html');
const cssPath = path.join(root, 'src', 'renderer', 'style.css');
const rendererPath = path.join(root, 'src', 'renderer', 'renderer.js');
const outPath = path.join(root, 'preview', 'index.html');

let html = fs.readFileSync(htmlPath, 'utf8');
let css = fs.readFileSync(cssPath, 'utf8');
let renderer = fs.readFileSync(rendererPath, 'utf8');

// Remove the CSP meta (preview serves plain http; minotar is allowed anyway).
html = html.replace(/<meta http-equiv="Content-Security-Policy".*?>/, '');

// Inline the titlebar logo as a data URL (preview serves a single file).
const logoPath = path.join(root, 'src', 'renderer', 'logo-titlebar.png');
if (fs.existsSync(logoPath)) {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
  html = html.split('src="logo-titlebar.png"').join(`src="${dataUrl}"`);
}

// Inline the background engine too (preview serves a single file).
const bgPath = path.join(root, 'src', 'renderer', 'backgrounds.js');
const bgJs = fs.readFileSync(bgPath, 'utf8');
// The preview mock lacks bg:* IPC — provide a minimal stand-in before it runs.
const bgMock = `<script>
  window.darklauncher.bgList = async () => ({ ok: true, files: [] });
  window.darklauncher.bgLoad = async () => ({ ok: false });
  window.darklauncher.bgChooseImage = async () => ({ ok: false });
  window.darklauncher.bgDelete = async () => ({ ok: true });
</script>`;
html = html.replace('<script src="backgrounds.js"></script>', bgMock + '\n  <script>\n' + bgJs + '\n  </script>');

// Inline the stylesheet instead of the link tag.
html = html.replace(/<link rel="stylesheet" href="style.css" \/>/, () => `<style>\n${css}\n</style>`);

// Mock API injected before the real renderer.js so it can run unchanged.
const mock = `<script>
// ---- Preview mock of window.darklauncher (real renderer.js runs below) ----
(function () {
  const VERSIONS = [
    ['1.21.8', '2026-07-30'], ['1.21.7', '2026-06-30'], ['1.21.6', '2026-05-30'],
    ['1.21.5', '2026-04-30'], ['1.21.4', '2026-03-30'], ['1.20.6', '2024-04-29'],
    ['1.20.4', '2023-12-07'], ['1.20.1', '2023-06-12'], ['1.19.4', '2023-03-14'],
    ['1.18.2', '2022-02-28'], ['1.17.1', '2021-07-06'], ['1.16.5', '2021-01-14'],
    ['1.12.2', '2017-09-18'], ['1.8.9', '2015-12-09'], ['1.21.8-rc1', '2026-07-28']
  ].map(([id, releaseDate]) => ({ id, releaseDate, type: /^\\d|\\d$/.test(id) && !id.includes('-') ? 'release' : 'snapshot' }));
  VERSIONS.push({ id: '24w40a', releaseDate: '2026-10-02', type: 'snapshot' });
  const installed = new Set(['1.21.4', '1.20.1', '1.8.9']);

  const listeners = { log: [], progress: [], state: [], window: [] };
  let running = false;

  const emit = (ev, data) => listeners[ev].forEach(cb => setTimeout(() => cb(data), 0));

  window.darklauncher = {
    minimize: () => flash('Minimize'),
    maximize: () => flash('Maximize'),
    close: () => flash('Close'),
    isMaximized: async () => false,
    openExternal: (u) => flash('Open ' + u),

    getSettings: async () => ({
      memory: 4096, javaPath: '', width: 1280, height: 720,
      fullscreen: false, keepLauncherOpen: true, lastUsername: 'Dark'
    }),
    setSettings: async (patch) => { Object.assign(mockSettings, patch); return { ok: true }; },

    listVersions: async (inc) => ({ ok: true, versions: inc ? VERSIONS : VERSIONS.filter(v => v.type === 'release') }),
    installedVersions: async () => [...installed],

    installedDetailed: async () => [
      { id: 'fabric-loader-0.16.5-1.21.4', isFabric: true, complete: true, lastPlayedAt: Date.now() - 3600e3, minutesPlayed: 142, diskBytes: 412e6 },
      { id: '1.21.4', isFabric: false, complete: true, lastPlayedAt: Date.now() - 86400e3, minutesPlayed: 2190, diskBytes: 388e6 },
      { id: '1.20.1', isFabric: false, complete: true, lastPlayedAt: null, minutesPlayed: 0, diskBytes: 341e6 },
      { id: '1.8.9', isFabric: false, complete: true, lastPlayedAt: Date.now() - 30 * 86400e3, minutesPlayed: 8321, diskBytes: 129e6 }
    ],
    deleteVersion: async (id) => { installed.delete(id); return { ok: true }; },
    installFabric: async (game, loader) => {
      emit('progress', { label: 'Fabric loader...', value: 0.5 });
      await new Promise(r => setTimeout(r, 800));
      emit('progress', { label: 'Fabric installed', value: 1 });
      const id = 'fabric-loader-' + (loader === 'latest' ? '0.16.5' : loader) + '-' + game;
      installed.add(id);
      return { ok: true, id };
    },

    searchMods: async (q) => ({
      ok: true,
      results: [
        { projectId: '1', slug: 'sodium', title: 'Sodium', description: 'A modern rendering engine that greatly improves frame rates and stuttering.', author: 'jellysquid3', downloads: 4200000, iconUrl: '' },
        { projectId: '2', slug: 'lithium', title: 'Lithium', description: 'Game logic optimizations that do not affect gameplay or mechanics.', author: 'jellysquid3', downloads: 3100000, iconUrl: '' },
        { projectId: '3', slug: 'fabric-api', title: 'Fabric API', description: 'Essential hooks for modding with Fabric — required by most mods.', author: 'modmuss50', downloads: 9800000, iconUrl: '' },
        { projectId: '4', slug: 'iris', title: 'Iris', description: 'Shaders pack loader compatible with OptiFine shader packs.', author: 'coderbot', downloads: 2400000, iconUrl: '' }
      ]
    }),
    topMods: async (gv, limit, offset) => {
      const all = [
        ['Sodium', 228124617], ['Iris Shaders', 177251985], ['Entity Culling', 167789970],
        ['Mod Menu', 144857228], ['ImmediatelyFast', 124154597], ['Lithium', 98765432],
        ['Fabric API', 88000000], ['Ferrite Core', 61000000], ['Cloth Config', 57000000]
      ];
      const pool = [];
      for (let i = 0; i < 250; i++) {
        const [t, d] = all[i % all.length];
        pool.push({ projectId: String(i), slug: t.toLowerCase().replace(/ /g, '-') + '-' + i, title: t + (i >= all.length ? ' ' + Math.floor(i / all.length + 1) : ''), description: 'One of the most downloaded Minecraft mods on Modrinth.', author: 'top100', downloads: Math.round(d / (i + 1)), iconUrl: '' });
      }
      const start = offset || 0;
      return { ok: true, results: pool.slice(start, start + (limit || 100)), total: 75890 };
    },
    cfStatus: async () => ({ ok: true, hasKey: true }),
    cfTopMods: async (gv, offset) => {
      const all = [
        ['JourneyMap', 42000000], ['Just Enough Items (JEI)', 39000000], ['Mouse Tweaks', 31000000],
        ['Clumps', 28000000], ['Performant', 19000000], ['AI Improvements', 12000000]
      ];
      const pool = [];
      for (let i = 0; i < 150; i++) {
        const [t, d] = all[i % all.length];
        pool.push({ projectId: 'cf' + i, slug: t.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + i, title: t + (i >= all.length ? ' ' + Math.floor(i / all.length + 1) : ''), description: 'CurseForge catalog entry (preview).', author: 'cf', downloads: Math.round(d / (i + 1)), iconUrl: '', source: 'curseforge' });
      }
      const start = offset || 0;
      return { ok: true, results: pool.slice(start, start + 50), total: 100000 };
    },
    cfSearchMods: async (q, gv, offset) => ({ ok: true, results: [], total: 0 }),
    cfInstallMod: async (pid) => { await new Promise(r => setTimeout(r, 500)); return { ok: true, files: ['cf-' + pid + '.jar'] }; },
    searchShaders: async (q, limit, src, offset) => ({ ok: true, total: 903, offset: offset || 0, results: Array.from({ length: Math.min(limit || 100, 903 - (offset || 0)) }, (_, i) => ({
      projectId: 's' + ((offset || 0) + i), slug: 'pack-' + ((offset || 0) + i), title: 'Shader Pack #' + ((offset || 0) + i + 1),
      description: 'Paged shader catalog preview entry.', author: 'preview', downloads: 900000 - i * 1000, iconUrl: ''
    })) }),
    topShaders: async (limit, src, offset) => ({ ok: true, total: 903, results: Array.from({ length: Math.min(limit || 100, 903 - (offset || 0)) }, (_, i) => ({
      projectId: 's' + ((offset || 0) + i), slug: 'pack-' + ((offset || 0) + i), title: 'Shader Pack #' + ((offset || 0) + i + 1),
      description: 'Paged shader catalog preview entry.', author: 'preview', downloads: 900000 - ((offset || 0) + i) * 1000, iconUrl: ''
    })) }),
    listShaders: async () => [
      { name: 'ComplementaryReimagined_r5.9.3.zip', size: 5242880 }
    ],
    installShader: async (slug) => { await new Promise(r => setTimeout(r, 600)); return { ok: true, file: slug + '-r5.9.3.zip' }; },
    removeShader: async () => ({ ok: true }),
    installMod: async (slug) => { await new Promise(r => setTimeout(r, 700)); return { ok: true, files: [slug + '-1.0.0.jar'] }; },
    listMods: async () => [
      { name: 'sodium-0.6.0.jar', size: 1048576 },
      { name: 'fabric-api-0.100.0.jar', size: 2097152 }
    ],
    removeMod: async () => ({ ok: true }),

    listServers: async () => [
      { id: 'srv_hypixel', name: 'Hypixel', host: 'mc.hypixel.net', port: 25565 },
      { id: 'srv_custom', name: 'My Private SMP', host: 'play.example.com', port: 25577 }
    ],
    addServer: async (s) => ({ ok: true, server: Object.assign({ id: 'srv_' + Date.now(), port: 25565 }, s) }),
    removeServer: async () => ({ ok: true }),

    activeAccount: async () => ({ name: 'Dark', type: 'offline', uuid: 'x' }),
    listAccounts: async () => [
      { name: 'Dark', type: 'offline', uuid: 'x' },
      { name: 'Notch', type: 'msa', uuid: 'y' }
    ],
    switchAccount: async (uuid) => ({ ok: true, account: { name: uuid === 'y' ? 'Notch' : 'Dark', type: uuid === 'y' ? 'msa' : 'offline' } }),
    signout: async () => ({ ok: true }),
    loginOffline: async (name) => ({ name, type: 'offline', uuid: 'x' }),
    msaStart: async () => ({ ok: true, userCode: 'DKLG-8888', verificationUri: 'https://microsoft.com/link', interval: 2 }),
    msaPoll: async () => ({ done: false }),

    launch: async (p) => {
      running = true;
      const files = ['client.jar','gson-2.10.1.jar','guava-32.0.1.jar','lwjgl-3.3.3.jar',
        'jopt-simple-5.0.4.jar','icu4j-71.1.jar','asm-9.5.jar','assets/indexes/17.json'];
      let i = 0;
      const step = () => {
        if (i < files.length) {
          i++;
          emit('progress', { label: 'Downloading ' + files[i - 1], value: i / (files.length + 2) });
          setTimeout(step, 160);
        } else {
          emit('progress', { label: 'Launching game...', value: 1 });
          emit('state', 'running');
          emit('log', '[launcher] Spawning java -Xmx4096M -cp ... net.minecraft.client.main.Main');
          emit('log', '[12:00:01] [Render thread/INFO]: Setting user: Dark');
          emit('log', '[12:00:02] [Render thread/INFO]: Backend library: LWJGL version 3.3.3');
          emit('log', '[12:00:04] [Render thread/INFO]: Sound engine started');
          flash('Minecraft launched (' + p.versionId + ')');
        }
      };
      setTimeout(step, 200);
      return { ok: true };
    },
    stopGame: async () => { running = false; emit('state', 'stopped'); return { ok: true }; },
    isRunning: async () => running,
    openGameFolder: () => flash('Opening game folder'),

    getAppInfo: async () => ({
      version: '1.1.0', electron: '33.0.0 (preview)', node: '20.x',
      platform: 'win32', dataDir: 'C:\\…\\appdata (preview)',
      logFile: 'C:\\…\\appdata\\logs\\darklauncher.log'
    }),
    openLogs: () => flash('Opening log folder'),

    onLog: (cb) => listeners.log.push(cb),
    onProgress: (cb) => listeners.progress.push(cb),
    onState: (cb) => listeners.state.push(cb),
    onWindow: (cb) => listeners.window.push(cb)
  };

  // Simulate an error-rich console stream so the error-code panel is reviewable.
  setTimeout(() => {
    emit('log', '[launcher] Spawning java -Xmx4096M -cp ... net.minecraft.client.main.Main');
    emit('log', '[12:00:01] [Render thread/INFO]: Setting user: Dark');
    emit('log', '[12:00:02] [Render thread/INFO]: Backend library: LWJGL version 3.3.3');
    emit('log', '[12:00:03] [Render thread/ERROR]: java.lang.OutOfMemoryError: Java heap space');
    emit('log', '[12:00:04] [Render thread/WARN]: Mod sodium may not support this loader version');
    emit('log', 'ERROR: Game crashed with exit code 1');
  }, 900);

  function flash(t) {
    const el = document.createElement('div');
    el.textContent = t;
    el.style.cssText = 'position:fixed;top:52px;right:16px;background:#8b5cf6;color:#fff;padding:6px 12px;border-radius:8px;font-size:12px;z-index:100;box-shadow:0 4px 20px rgba(139,92,246,.5)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  const mockSettings = {};
})();
</script>`;

html = html.replace('<script src="renderer.js"></script>', mock + '\n  <script>' + renderer + '</script>');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log(`preview/index.html written (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
