'use strict';

// Renderer logic: navigation, version list, launch flow, settings, accounts.

const api = window.darklauncher;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- toasts
function toast(message, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}
const state = {
  versions: [],
  installedSet: new Set(),
  selectedVersion: localStorage.getItem('dl.version') || '',
  installing: false,
  running: false
};

// ---------------------------------------------------------------- navigation
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    $(`page-${btn.dataset.page}`).classList.add('active');
    if (btn.dataset.page === 'shaders') {
      // Populate the shaders page on first visit.
      if (!$('shader-results').children.length) loadShaders('top');
      loadShaderFiles();
    }
  });
});

// ---------------------------------------------------------------- window controls
$('btn-min').addEventListener('click', () => api.minimize());
$('btn-max').addEventListener('click', () => api.maximize());
$('btn-close').addEventListener('click', () => api.close());
api.onWindow((s) => {
  $('btn-max').innerHTML = s === 'maximized' ? '&#x2922;' : '&#x25A1;';
});

// ---------------------------------------------------------------- account display
const faceCache = new Map();

function faceUrl(name, size) {
  return `https://minotar.net/helm/${encodeURIComponent(name)}/${size}`;
}

function setFace(imgEl, name, size) {
  if (!imgEl) return; // element may not exist on a redesigned page
  const url = faceUrl(name, size);
  imgEl.style.background = '';
  imgEl.onerror = () => {
    // Offline fallback: colored initial tile, no broken image.
    imgEl.removeAttribute('src');
    const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    imgEl.style.background = `linear-gradient(135deg, hsl(${hue},60%,40%), hsl(${(hue + 40) % 360},60%,30%))`;
    imgEl.alt = name.slice(0, 1).toUpperCase();
  };
  if (imgEl.src !== url) imgEl.src = url;
}

function renderAccount(acc) {
  const name = acc ? acc.name : 'Player';
  const type = acc ? (acc.type === 'msa' ? 'Microsoft' : 'Offline') : 'Offline';
  $('account-name').textContent = name;
  $('account-type').textContent = type;
  // Profile card on Home mirrors the sidebar chip.
  const pn = $('profile-name'), pt = $('profile-type');
  if (pn) pn.textContent = name;
  if (pt) pt.textContent = type;
  setFace($('big-face'), name, 96);
  setFace($('account-face'), name, 32);
}

// ---------------------------------------------------------------- versions
async function loadVersions() {
  const list = $('version-list');
  list.innerHTML = '<div class="muted" style="padding:8px">Loading versions...</div>';
  const res = await api.listVersions($('show-snapshots').checked);
  if (!res.ok) {
    list.innerHTML = `<div class="muted" style="padding:8px">Failed to load: ${res.error}</div>`;
    return;
  }
  state.versions = res.versions;
  const installed = await api.installedVersions();
  state.installedSet = new Set(installed);
  renderVersionList();
}

function renderVersionList() {
  const list = $('version-list');
  const query = $('version-search').value.trim().toLowerCase();
  const shown = state.versions.filter(v => v.id.toLowerCase().includes(query)).slice(0, 200);

  list.innerHTML = '';
  for (const v of shown) {
    const el = document.createElement('div');
    el.className = 'ver-item' + (v.id === state.selectedVersion ? ' selected' : '');
    el.innerHTML = `
      <span class="v-main"><span class="v-id">${v.id}</span>${v.releaseDate ? `<span class="v-date">${v.releaseDate}</span>` : ''}</span>
      <span style="display:flex;align-items:center">
        ${state.installedSet.has(v.id) ? '<span class="v-installed">installed</span>' : ''}
        <span class="v-type ${v.type}">${v.type}</span>
      </span>`;
    el.addEventListener('click', () => {
      state.selectedVersion = v.id;
      localStorage.setItem('dl.version', v.id);
      document.querySelectorAll('.ver-item').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      setStatus(`Selected ${v.id}`);
    });
    list.appendChild(el);
  }
  if (!shown.length) {
    list.innerHTML = '<div class="muted" style="padding:8px">No versions match.</div>';
  }
}

$('show-snapshots').addEventListener('change', loadVersions);
$('version-search').addEventListener('input', () => renderVersionList());

// ---------------------------------------------------------------- launch
function setStatus(msg) { $('play-status').textContent = msg; }

function setPlayButtons() {
  $('btn-play').disabled = state.installing || state.running;
  $('btn-stop').classList.toggle('hidden', !state.running);
}

$('btn-play').addEventListener('click', async () => {
  if (state.installing || state.running) return;
  if (!state.selectedVersion) {
    setStatus('Pick a version first!');
    return;
  }
  state.installing = true;
  setPlayButtons();
  $('progress-wrap').classList.remove('hidden');
  setStatus('Launching...');
  $('progress-fill').style.width = '0%';

  const serverId = $('join-server').value || undefined;
  const res = await api.launch({ versionId: state.selectedVersion, serverId });
  if (!res.ok) {
    setStatus(`Failed: ${res.error}`);
    toast(`Launch failed: ${res.error}`, 'error', 6000);
    state.installing = false;
    setPlayButtons();
  }
});

$('btn-stop').addEventListener('click', async () => {
  await api.stopGame();
  setStatus('Stopping Minecraft...');
});

api.onProgress((p) => {
  $('progress-label').textContent = p.label;
  $('progress-fill').style.width = `${Math.round(p.value * 100)}%`;
  if (p.value >= 1) {
    setTimeout(() => $('progress-wrap').classList.add('hidden'), 1200);
  }
});

// ---------------------------------------------------------------- console: error codes
// Known Minecraft crash signatures -> plain-language explanations + fixes.
// Ordered by specificity; first match wins.
const ERROR_CODES = [
  { re: /java\.lang\.OutOfMemoryError/i, code: 'java.lang.OutOfMemoryError',
    why: 'The JVM ran out of RAM. Shaders/mods need more memory than allocated.',
    fix: 'Settings → Memory slider to 6-8 GB. Shader+mod setups often need 6 GB+.' },
  { re: /UnsupportedClassVersionError.*class file version (\d+)/i, code: 'UnsupportedClassVersionError',
    why: 'A mod or library was built for a newer Java than the game is using.',
    fix: 'Delete the custom Java path in Settings (auto-download will pick the right runtime), or install the Java version the mod requires.' },
  { re: /GL_(ARB|VERSION)|LWJGL.*OpenGL|Pixel format not accelerated/i, code: 'OpenGL/LWJGL error',
    why: 'Graphics driver could not provide OpenGL (common on VMs/remote desktop/old drivers).',
    fix: 'Update your GPU driver. On remote desktop/VM, run the game on the physical machine.' },
  { re: /Failed to (load|verify) (a )?libraries|Could not (find or )?load main class net\.fabricmc/i, code: 'Fabric libraries missing',
    why: 'Fabric loader libraries are missing or corrupt in the instance.',
    fix: 'Versions → delete the Fabric instance → reinstall Fabric.' },
  { re: /NoSuchMethodError|NoClassDefFoundError.*(fabric|modrinth)/i, code: 'Mod/loader version mismatch',
    why: 'A mod version does not match the installed Fabric loader or another mod.',
    fix: 'Mods page → remove the mod → reinstall its latest build for your exact Minecraft version.' },
  { re: /Access is denied|Permission denied/i, code: 'Permission denied',
    why: 'Windows blocked a file the game needs (antivirus or OneDrive sync lock).',
    fix: 'Add the launcher folder to antivirus exclusions; pause OneDrive sync for it.' },
  { re: /The system cannot find the (path|file) specified/i, code: 'File not found',
    why: 'A required file (java, jar, natives) is missing from disk.',
    fix: 'Versions → delete the version → launch again so it re-downloads fresh.' },
  { re: /exit code (-?\d+)/i, code: 'Non-zero exit code',
    why: 'The game process ended abnormally. The lines above usually show the real cause.',
    fix: 'Scroll up to the first red ERROR line and match it against this list.' },
  { re: /Connection (refused|timed out)|Unknown host|Failed to connect to (the )?server/i, code: 'Server connection failed',
    why: 'The server is offline, the address is wrong, or your network blocks it.',
    fix: 'Check the server address/port in Servers, and that the server is online.' },
  { re: /Invalid session|Failed to verify username/i, code: 'Invalid session',
    why: 'Online servers reject offline accounts. This is expected without a real account.',
    fix: 'Use offline-friendly servers, or sign in with a Microsoft account.' }
];

function analyzeCrashLines(lines) {
  const joined = lines.join('\n');
  const found = [];
  for (const e of ERROR_CODES) {
    if (e.re.test(joined)) found.push(e);
    if (found.length >= 3) break;
  }
  return found;
}

function renderCrashHints(matches) {
  const wrap = $('crash-hints');
  if (!matches.length) {
    wrap.innerHTML = '<span class="muted">No known crash patterns in the recent output.</span>';
    return;
  }
  wrap.innerHTML = matches.map((m) => `
    <div class="crash-hint">
      <b>${esc(m.code)}</b><br/>${esc(m.why)}<br/>
      <span class="muted">Fix: ${esc(m.fix)}</span>
    </div>`).join('');
}

// Live analysis: whenever an error-looking line arrives, analyze the last 200.
function analyzeRecentConsole() {
  const lines = [...document.querySelectorAll('#console > span')]
    .map((el) => el.textContent).slice(-200);
  renderCrashHints(analyzeCrashLines(lines));
}

function applyConsoleFilter() {
  const q = $('console-filter').value.trim().toLowerCase();
  const errorsOnly = $('console-errors-only').checked;
  document.querySelectorAll('#console > span').forEach((el) => {
    const isError = /ERROR|FATAL|Exception/i.test(el.textContent);
    const okQ = !q || el.textContent.toLowerCase().includes(q);
    const okE = !errorsOnly || isError;
    el.classList.toggle('hidden-by-filter', !(okQ && okE));
  });
}

$('console-filter').addEventListener('input', applyConsoleFilter);
$('console-errors-only').addEventListener('change', applyConsoleFilter);
$('btn-copy-errors').addEventListener('click', () => {
  const errs = [...document.querySelectorAll('#console > span')]
    .filter((el) => /ERROR|FATAL|Exception/i.test(el.textContent))
    .map((el) => el.textContent.trim()).join('\n');
  if (!errs) { toast('No error lines to copy', 'error'); return; }
  navigator.clipboard.writeText(errs).then(
    () => toast(`Copied ${errs.split('\n').length} error lines`, 'ok'),
    () => toast('Clipboard blocked by the system', 'error')
  );
});
$('btn-crash-analysis').addEventListener('click', analyzeRecentConsole);

api.onLog((msg) => {
  const con = $('console');
  const line = document.createElement('span');
  line.className = 'log-line';
  // Color-code log lines for quick scanning.
  if (/ERROR|FATAL|Exception in/i.test(msg)) line.classList.add('log-err');
  else if (/WARN/i.test(msg)) line.classList.add('log-warn');
  else line.classList.add('log-sys');
  line.textContent = msg + '\n';
  // Respect active filters on append too.
  const q = $('console-filter').value.trim().toLowerCase();
  const errorsOnly = $('console-errors-only').checked;
  const isError = /ERROR|FATAL|Exception/i.test(msg);
  if ((q && !msg.toLowerCase().includes(q)) || (errorsOnly && !isError)) {
    line.classList.add('hidden-by-filter');
  }
  con.appendChild(line);
  // Keep memory sane: cap the console at 2500 lines.
  while (con.children.length > 2500) con.removeChild(con.firstChild);
  con.scrollTop = con.scrollHeight;
  if (isError) analyzeRecentConsole();
  if (msg.startsWith('ERROR:')) { setStatus(msg); toast(msg.slice(7), 'error', 6000); }
});

api.onState((s) => {
  if (s === 'running') {
    state.running = true;
    state.installing = false;
    setStatus('Minecraft is running.');
    toast('Minecraft launched! Have fun.', 'ok');
    // Auto-hide when the user opted out of keeping the launcher open.
    api.getSettings().then((st) => {
      if (!st.keepLauncherOpen && api.hideToTray) api.hideToTray();
    });
  }
  if (s === 'stopped') {
    if (state.running) toast('Game closed.');
    state.running = false;
    state.installing = false;
    setStatus('Game closed.');
  }
  setPlayButtons();
});

// ---------------------------------------------------------------- accounts
function refreshAccountsPanel() {
  api.listAccounts().then((accounts) => {
    const wrap = $('account-list');
    wrap.innerHTML = '';
    if (!accounts.length) {
      wrap.innerHTML = '<p class="muted">No saved accounts. Sign in below.</p>';
      return;
    }
    for (const acc of accounts) {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.innerHTML = `
        <span class="acc-dot ${acc.type}"></span>
        <span class="acc-name">${acc.name}</span>
        <span class="acc-tag">${acc.type === 'msa' ? 'Microsoft' : 'Offline'}</span>
        <button class="btn small acc-use">Use</button>`;
      row.querySelector('.acc-use').addEventListener('click', async () => {
        const res = await api.switchAccount(acc.uuid);
        if (res.ok) {
          renderAccount(res.account);
          setStatus(`Switched to ${res.account.name}`);
          refreshAccountsPanel();
        }
      });
      wrap.appendChild(row);
    }
  });
}

$('btn-offline').addEventListener('click', async () => {
  const name = $('offline-name').value.trim() || 'Player';
  const acc = await api.loginOffline(name);
  renderAccount(acc);
  refreshAccountsPanel();
  setStatus(`Switched to offline account: ${name}`);
});

let msaInterval = null;

function stopMsaPolling() {
  if (msaInterval) { clearInterval(msaInterval); msaInterval = null; }
}

$('btn-msa').addEventListener('click', async () => {
  stopMsaPolling();
  const start = await api.msaStart();
  $('msa-box').classList.remove('hidden');
  if (!start.ok) {
    $('msa-status').textContent = `Error: ${start.error}`;
    return;
  }
  $('msa-code').textContent = start.userCode;
  $('msa-uri').textContent = start.verificationUri;
  $('msa-uri').onclick = (e) => {
    e.preventDefault();
    api.openExternal(start.verificationUri);
  };
  $('msa-status').textContent = 'Waiting for approval...';

  msaInterval = setInterval(async () => {
    const poll = await api.msaPoll();
    if (poll.done) {
      stopMsaPolling();
      if (poll.error) {
        $('msa-status').textContent = `Error: ${poll.error}`;
      } else {
        $('msa-status').textContent = `Signed in as ${poll.account.name}!`;
        renderAccount(poll.account);
        refreshAccountsPanel();
      }
    }
  }, (start.interval || 5) * 1000);
});

$('btn-signout').addEventListener('click', async () => {
  stopMsaPolling();
  await api.signout();
  renderAccount(null);
  refreshAccountsPanel();
  setStatus('Signed out.');
});

$('btn-open-folder').addEventListener('click', () => api.openGameFolder());

// ---------------------------------------------------------------- settings
const BG_THEMES = [
  ['off', 'Off (plain dark)'],
  ['blocks', 'Minecraft blocks floating'],
  ['custom', 'Custom blocks (your images!)'],
  ['redmoon', 'Red moon (Akatsuki)'],
  ['warp', 'Starfield warp'],
  ['matrix', 'Digital rain'],
  ['lava', 'Lava lamp'],
  ['hills', 'Night hills'],
  ['creeper', 'Creeper faces'],
  ['grid', 'Synthwave grid'],
  ['snow', 'Snowfall'],
  ['embers', 'Rising embers'],
  ['underwater', 'Underwater'],
  ['constellation', 'Constellation'],
  ['tntrain', 'TNT rain'],
  ['diamond', 'Diamond shimmer'],
  ['aurora', 'Aurora waves']
];

async function initBackgroundPanel() {
  const sel = $('bg-theme');
  sel.innerHTML = BG_THEMES.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  const s = await api.getSettings();
  sel.value = s.backgroundTheme || 'blocks';
  if (window.DarkBG) {
    DarkBG.setTheme(sel.value);
    if (s.backgroundImage) DarkBG.setBackgroundImage(s.backgroundImage);
  }
  sel.addEventListener('change', async () => {
    if (window.DarkBG) DarkBG.setTheme(sel.value);
    await api.setSettings({ backgroundTheme: sel.value });
  });
  renderBgImages();
}

async function renderBgImages() {
  const wrap = $('bg-images');
  const res = await api.bgList();
  if (!res.ok || !res.files.length) {
    wrap.innerHTML = '<p class="muted">No images yet — add one and use it as the background or in Custom blocks.</p>';
    return;
  }
  const s = await api.getSettings();
  wrap.innerHTML = '';
  for (const name of res.files) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const isBg = s.backgroundImage === name;
    row.innerHTML = `
      <span class="acc-name">${esc(name)}${isBg ? ' · <b>background</b>' : ''}</span>
      <span style="display:flex;gap:6px">
        <button class="btn small bg-use">Use as background</button>
        <button class="btn small danger-soft bg-del">Remove</button>
      </span>`;
    row.querySelector('.bg-use').addEventListener('click', async () => {
      if (window.DarkBG) await DarkBG.setBackgroundImage(name);
      await api.setSettings({ backgroundImage: s.backgroundImage === name ? '' : name });
      renderBgImages();
      toast('Background image updated', 'ok');
    });
    row.querySelector('.bg-del').addEventListener('click', async () => {
      await api.bgDelete(name);
      renderBgImages();
    });
    wrap.appendChild(row);
  }
}

$('btn-bg-add-image').addEventListener('click', async () => {
  const res = await api.bgChooseImage();
  if (res.ok) { renderBgImages(); toast('Image added — pick "Custom blocks" to float it!', 'ok', 5000); }
});

async function loadSettings() {
  const s = await api.getSettings();
  $('set-memory').value = s.memory;
  $('mem-label').textContent = `${s.memory} MB`;
  $('set-java').value = s.javaPath || '';
  $('set-cfkey').value = s.curseforgeKey || '';
  $('set-width').value = s.width;
  $('set-height').value = s.height;
  $('set-fullscreen').checked = !!s.fullscreen;
  $('set-keepopen').checked = !!s.keepLauncherOpen;
  $('set-closetotray').checked = s.closeToTray !== false;
  if (s.lastUsername && !$('offline-name').value) $('offline-name').value = s.lastUsername;
}

$('set-memory').addEventListener('input', () => {
  $('mem-label').textContent = `${$('set-memory').value} MB`;
});

$('btn-save-settings').addEventListener('click', async () => {
  await api.setSettings({
    memory: parseInt($('set-memory').value, 10) || 4096,
    javaPath: $('set-java').value.trim(),
    curseforgeKey: $('set-cfkey').value.trim(),
    width: parseInt($('set-width').value, 10) || 1280,
    height: parseInt($('set-height').value, 10) || 720,
    fullscreen: $('set-fullscreen').checked,
    keepLauncherOpen: $('set-keepopen').checked,
    closeToTray: $('set-closetotray').checked
  });
  $('btn-save-settings').textContent = 'Saved!';
  setTimeout(() => { $('btn-save-settings').textContent = 'Save Settings'; }, 1500);
});

$('btn-clear-console').addEventListener('click', () => {
  $('console').textContent = '';
  $('crash-hints').innerHTML = '<span class="muted">Launch the game — common crash codes will be explained here automatically.</span>';
});

// ---------------------------------------------------------------- about panel
async function loadAbout() {
  try {
    const info = await api.getAppInfo();
    $('about-version').textContent = `Darklauncher v${info.version}`;
    $('about-detail').textContent = `Electron ${info.electron} · ${info.platform}`;
    $('about-datadir').textContent = info.dataDir;
    $('about-logfile').textContent = info.logFile || '—';
  } catch (_) { /* preview/mock */ }
}

$('btn-open-logs').addEventListener('click', () => api.openLogs());

// ---------------------------------------------------------------- version management page
function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadVersionsPage() {
  refreshFabricGamePicker();
  const wrap = $('versions-table');
  wrap.innerHTML = '<p class="muted">Loading...</p>';
  const rows = await api.installedDetailed();
  if (!rows.length) {
    wrap.innerHTML = '<p class="muted">Nothing installed yet — launch a version and it will appear here.</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const v of rows) {
    const el = document.createElement('div');
    el.className = 'version-row';
    const played = v.lastPlayedAt
      ? new Date(v.lastPlayedAt).toLocaleDateString() + ' · ' + (v.minutesPlayed || 0) + ' min'
      : 'never played';
    el.innerHTML = `
      <span class="vr-id">${v.id}${v.isFabric ? ' <span class="v-tag">Fabric</span>' : ''}</span>
      <span class="muted">${played}</span>
      <span class="muted">${humanBytes(v.diskBytes)}</span>
      <button class="btn small danger-soft vr-del">Delete</button>`;
    el.querySelector('.vr-del').addEventListener('click', async () => {
      if (!confirm(`Delete ${v.id} from disk?`)) return;
      const res = await api.deleteVersion(v.id);
      if (res.ok) { toast(`Deleted ${v.id}`, 'ok'); loadVersionsPage(); loadVersions(); }
      else toast(res.error || 'Delete failed', 'error');
    });
    wrap.appendChild(el);
  }
}

$('btn-refresh-versions').addEventListener('click', loadVersionsPage);

// Populate the Fabric installer's game-version picker from the live manifest
// (releases first, then snapshots). Cached by the backend, so this is cheap.
async function refreshFabricGamePicker() {
  const sel = $('fabric-game');
  const prev = sel.value;
  const res = await api.listVersions(false);
  if (!res.ok || !res.versions.length) return;
  sel.innerHTML = '';
  for (const v of res.versions.slice(0, 200)) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.id}${v.releaseDate ? '  (' + v.releaseDate + ')' : ''}`;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

$('btn-fabric-install').addEventListener('click', async () => {
  const game = ($('fabric-game').value || '').trim();
  const loader = $('fabric-loader').value.trim() || 'latest';
  if (!/^\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(game)) {
    toast('Pick a Minecraft version from the list', 'error');
    return;
  }
  const btn = $('btn-fabric-install');
  btn.disabled = true;
  btn.textContent = 'Installing...';
  $('progress-wrap').classList.remove('hidden');
  $('progress-fill').style.width = '0%';
  const res = await api.installFabric(game, loader);
  btn.disabled = false;
  btn.textContent = 'Install Fabric';
  if (res.ok) {
    toast(`Fabric installed: ${res.id}`, 'ok', 5000);
    setStatus(`Fabric ready: ${res.id}`);
    await loadVersions();
    loadVersionsPage();
    refreshInstanceSelects();
  } else {
    toast(`Fabric failed: ${res.error}`, 'error', 6000);
  }
});

// ---------------------------------------------------------------- mods page
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function refreshInstanceSelects() {
  const rows = await api.installedDetailed();
  const fabricOnly = rows.filter(v => v.isFabric);
  // Mods page instance picker
  const sel = $('mods-instance');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!fabricOnly.length) {
    sel.innerHTML = '<option value="">— Install Fabric first —</option>';
  } else {
    for (const v of fabricOnly) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.id;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }
  // Home page join-server picker
  const servers = await api.listServers();
  const js = $('join-server');
  const prevSrv = js.value;
  js.innerHTML = '<option value="">Singleplayer / server browser</option>';
  for (const s of servers) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `Join ${s.name} (${s.host})`;
    js.appendChild(opt);
  }
  if (prevSrv) js.value = prevSrv;
  // Populate installed-mods panel now that the instance picker is ready.
  loadModsInstalled();
}

async function searchMods() { loadModsPage('search', { reset: true }); }

$('btn-mods-search').addEventListener('click', searchMods);
$('mods-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMods(); });

// ------------------------------------------------------------ catalog state
// Shared state for the mods list: which query produced the current cards,
// how deep we have paged, and the Modrinth-reported total.
const modsList = { mode: null, gameVersion: null, shown: 0, total: 0, busy: false };
const CATALOG_MAX = 10000;

function catalogCap() { return modsSource() === 'curseforge' ? 10000 : 100000; }

function modsCountLabel() {
  const cap = catalogCap();
  $('mods-count').textContent = modsList.total
    ? `${modsList.shown} / ${Math.min(modsList.total, cap).toLocaleString()} mods`
    : '';
  $('btn-mods-more').classList.toggle('hidden',
    !modsList.mode || modsList.shown >= Math.min(modsList.total, cap) || modsList.shown >= cap);
}

async function fetchModsPage(mode, offset) {
  const gameVersion = ($('mods-instance').value || '').replace(/^fabric-loader-[\w.]+-/, '');
  if (modsSource() === 'curseforge') {
    // CurseForge: 50/page, sorted by total downloads.
    return mode === 'top'
      ? api.cfTopMods(gameVersion || null, offset)
      : api.cfSearchMods($('mods-search').value.trim(), gameVersion || null, offset);
  }
  if (mode === 'top') {
    return api.topMods(gameVersion || null, 100, offset);
  }
  const q = $('mods-search').value.trim();
  return api.searchMods(q, gameVersion || null, { limit: 100, offset });
}

function modsSource() { return $('mods-source').value; }
function shaderSource() { return $('shader-source').value; }

async function loadModsPage(mode, { reset } = { reset: true }) {
  if (modsList.busy) return;
  modsList.busy = true;
  const wrap = $('mods-results');
  const offset = reset ? 0 : modsList.shown;
  if (reset) { wrap.innerHTML = '<p class="muted">Loading Modrinth catalog...</p>'; }
  const res = await fetchModsPage(mode, offset);
  modsList.busy = false;
  if (!res.ok) {
    if (reset) wrap.innerHTML = `<p class="muted">Failed: ${esc(res.error)}</p>`;
    return;
  }
  if (reset) { wrap.innerHTML = ''; modsList.total = res.total || 0; }
  modsList.mode = mode;
  modsList.source = modsSource();
  modsList.gameVersion = ($('mods-instance').value || '').replace(/^fabric-loader-[\w.]+-/, '');
  modsList.shown = offset + res.results.length;
  if (reset && !res.results.length) {
    wrap.innerHTML = '<p class="muted">No mods found.</p>';
    modsCountLabel();
    return;
  }
  renderModResults(res.results, mode === 'top' && reset);
  modsCountLabel();
}

// Top 100 most-downloaded mods for the selected instance's game version.
function showTopMods() { loadModsPage('top', { reset: true }); }

$('btn-mods-more').addEventListener('click', () => loadModsPage(modsList.mode, { reset: false }));

// Switching catalog source resets the list and reveals the CF key hint if needed.
$('mods-source').addEventListener('change', async () => {
  const cf = modsSource() === 'curseforge';
  const st = cf ? await api.cfStatus() : { hasKey: true };
  $('cf-hint').classList.toggle('hidden', !cf || st.hasKey);
  loadModsPage('top', { reset: true });
});

// Shared card renderer for mods and shader cards. `kind` picks the install flow.
function sourceOf(m, fallback) { return m.source === 'curseforge' ? 'curseforge' : fallback; }

// Shared card renderer for search results and the Top 100 list. Ranked only
// applies to the first page of the Top list (the offset is added for more).
function renderModResults(results, ranked) {
  const wrap = $('mods-results');
  results.forEach((m, i) => {
    const rank = ranked ? i + 1 : (modsList.mode === 'top' ? modsList.shown - results.length + i + 1 : 0);
    const el = document.createElement('div');
    el.className = 'mod-card';
    el.innerHTML = `
      <div class="mod-head">
        <img class="mod-icon" src="${esc(m.iconUrl)}" onerror="this.style.visibility='hidden'" />
        <div>
          <div class="mod-title">${rank ? `#${rank} · ` : ''}${esc(m.title)}</div>
          <div class="muted mod-desc">${esc(m.description)}</div>
          <div class="muted mod-meta">by ${esc(m.author)} · ${m.downloads.toLocaleString()} downloads</div>
        </div>
      </div>
      <button class="btn small mod-install">Install</button>`;
    el.querySelector('.mod-install').addEventListener('click', async (e) => {
      const fabricId = $('mods-instance').value;
      if (!fabricId) { toast('Pick a Fabric instance first', 'error'); return; }
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Installing...';
      $('progress-wrap').classList.remove('hidden');
      const game = fabricId.replace(/^fabric-loader-[\w.]+-/, '');
      const res2 = sourceOf(m, modsSource()) === 'curseforge'
        ? await api.cfInstallMod(m.projectId, game, fabricId)
        : await api.installMod(m.slug, game, fabricId);
      btn.disabled = false;
      btn.textContent = 'Install';
      if (res2.ok) {
        toast(`Installed ${res2.files.length} file(s)`, 'ok');
        loadModsInstalled();
      } else {
        toast(`Install failed: ${res2.error}`, 'error', 6000);
      }
    });
    wrap.appendChild(el);
  });
}

$('btn-mods-top').addEventListener('click', showTopMods);

async function loadModsInstalled() {
  const fabricId = $('mods-instance').value;
  const wrap = $('mods-installed');
  if (!fabricId) {
    wrap.innerHTML = '<p class="muted">No Fabric instance selected.</p>';
    return;
  }
  const files = await api.listMods(fabricId);
  if (!files.length) {
    wrap.innerHTML = '<p class="muted">No mods installed in this instance yet.</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.innerHTML = `
      <span class="acc-name">${esc(f.name)}</span>
      <span class="muted">${humanBytes(f.size)}</span>
      <button class="btn small danger-soft">Remove</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      const res = await api.removeMod(fabricId, f.name);
      if (res.ok) { toast(`Removed ${f.name}`, 'ok'); loadModsInstalled(); }
      else toast(res.error || 'Remove failed', 'error');
    });
    wrap.appendChild(row);
  }
}

$('btn-mods-refresh').addEventListener('click', loadModsInstalled);
$('mods-instance').addEventListener('change', loadModsInstalled);

// ---------------------------------------------------------------- shaders page
// Paged shader catalog: 100 per page, "Load more" appends up to the whole
// catalog (Modrinth ~900+ packs, CurseForge 10k API cap).
const shaderList = { kind: 'top', query: '', shown: 0, total: 0, busy: false };

function shaderCountLabel() {
  $('shader-count').textContent = shaderList.total
    ? `${shaderList.shown} / ${shaderList.total.toLocaleString()} shader packs`
    : '';
  $('btn-shader-more').classList.toggle('hidden',
    !shaderList.total || shaderList.shown >= shaderList.total || shaderList.busy);
}

async function loadShaders(kind, query, { reset = true } = {}) {
  if (shaderList.busy) return;
  shaderList.busy = true;
  const src = shaderSource();
  const wrap = $('shader-results');
  const pageSize = src === 'curseforge' ? 50 : 100;
  const offset = reset ? 0 : shaderList.shown;
  if (reset) wrap.innerHTML = '<p class="muted">Loading shader packs...</p>';
  else $('btn-shader-more').classList.add('hidden');

  const res = kind === 'search'
    ? await api.searchShaders(query, pageSize, src, offset)
    : await api.topShaders(pageSize, src, offset);
  shaderList.busy = false;
  if (!res.ok) {
    if (reset) wrap.innerHTML = `<p class="muted">Failed: ${esc(res.error || 'unknown error')}</p>`;
    return;
  }
  if (reset) {
    wrap.innerHTML = '';
    shaderList.total = res.total || 0;
    shaderList.kind = kind;
    shaderList.query = query || '';
    shaderList.shown = 0;
    if (!res.results.length) {
      wrap.innerHTML = '<p class="muted">No shader packs found.</p>';
      shaderCountLabel();
      return;
    }
  }
  const baseRank = offset;
  res.results.forEach((m, idx) => {
    const rank = shaderList.kind === 'top' ? baseRank + idx + 1 : 0;
    const el = document.createElement('div');
    el.className = 'mod-card';
    el.innerHTML = `
      <div class="mod-head">
        <img class="mod-icon" src="${esc(m.iconUrl)}" onerror="this.style.visibility='hidden'" />
        <div>
          <div class="mod-title">${rank ? `#${rank} · ` : ''}${esc(m.title)}</div>
          <div class="muted mod-desc">${esc(m.description)}</div>
          <div class="muted mod-meta">by ${esc(m.author)} · ${m.downloads.toLocaleString()} downloads</div>
        </div>
      </div>
      <button class="btn small mod-install">Install</button>`;
    el.querySelector('.mod-install').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Installing...';
      $('progress-wrap').classList.remove('hidden');
      const res2 = await api.installShader(m.slug, sourceOf(m, shaderSource()));
      btn.disabled = false;
      btn.textContent = 'Install';
      if (res2.ok) {
        toast(`Shader installed: ${res2.file}`, 'ok');
        loadShaderFiles();
      } else {
        toast(`Install failed: ${res2.error}`, 'error', 6000);
      }
    });
    wrap.appendChild(el);
  });
  shaderList.shown = offset + res.results.length;
  shaderCountLabel();
}

// CurseForge key hint on the shaders page too.
$('shader-source').addEventListener('change', async () => {
  const cf = shaderSource() === 'curseforge';
  const st = cf ? await api.cfStatus() : { hasKey: true };
  if (cf && !st.hasKey) toast('CurseForge needs an API key — Settings → CurseForge API key', 'error', 6000);
  loadShaders('top');
});

async function loadShaderFiles() {
  const wrap = $('shader-installed');
  const files = await api.listShaders();
  if (!files.length) {
    wrap.innerHTML = '<p class="muted">No shader packs installed yet.</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.innerHTML = `
      <span class="acc-name">${esc(f.name)}</span>
      <span class="muted">${humanBytes(f.size)}</span>
      <button class="btn small danger-soft">Remove</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      const res = await api.removeShader(f.name);
      if (res.ok) { toast(`Removed ${f.name}`, 'ok'); loadShaderFiles(); }
      else toast(res.error || 'Remove failed', 'error');
    });
    wrap.appendChild(row);
  }
}

$('btn-shader-search').addEventListener('click', () => loadShaders('search', $('shader-search').value.trim()));
$('shader-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadShaders('search', $('shader-search').value.trim()); });
$('btn-shader-top').addEventListener('click', () => loadShaders('top'));
$('btn-shader-refresh').addEventListener('click', loadShaderFiles);
$('btn-shader-more').addEventListener('click', () => loadShaders(shaderList.kind, shaderList.query, { reset: false }));

// ---------------------------------------------------------------- servers page
async function loadServers() {
  const servers = await api.listServers();
  const wrap = $('server-list');
  wrap.innerHTML = '';
  if (!servers.length) {
    wrap.innerHTML = '<p class="muted">No servers saved yet.</p>';
  } else {
    for (const s of servers) {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.innerHTML = `
        <span class="acc-dot msa"></span>
        <span class="acc-name">${esc(s.name)}</span>
        <span class="acc-tag">${esc(s.host)}${s.port !== 25565 ? ':' + s.port : ''}</span>
        <button class="btn small danger-soft">Delete</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        await api.removeServer(s.id);
        loadServers();
        refreshInstanceSelects();
      });
      wrap.appendChild(row);
    }
  }
  refreshInstanceSelects();
}

$('btn-srv-add').addEventListener('click', async () => {
  const res = await api.addServer({
    name: $('srv-name').value,
    host: $('srv-host').value,
    port: parseInt($('srv-port').value, 10) || 25565
  });
  if (res.ok) {
    toast(`Server saved: ${res.server.name}`, 'ok');
    $('srv-name').value = '';
    $('srv-host').value = '';
    $('srv-port').value = '';
    loadServers();
  } else {
    toast(res.error || 'Could not save', 'error');
  }
});

// ---------------------------------------------------------------- init
(async function init() {
  const acc = await api.activeAccount();
  renderAccount(acc);
  refreshAccountsPanel();
  await loadSettings();
  initBackgroundPanel();
  await loadVersions();
  loadAbout();
  loadVersionsPage();
  refreshInstanceSelects();
  loadServers();
  const running = await api.isRunning();
  state.running = !!running;
  setPlayButtons();
  if (running) setStatus('Minecraft is running.');
})();
