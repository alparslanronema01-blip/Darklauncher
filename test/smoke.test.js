'use strict';
// Smoke test for core launcher logic (no Electron, no network).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Copy src into a temp dir so appdata/ is created there, not in the project.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darklauncher-test-'));
const root = path.join(tmp, 'app');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
for (const f of ['store.js', 'versions.js', 'launcher.js', 'java.js', 'util.js', 'logger.js', 'fabric.js', 'modrinth.js', 'instances.js', 'shortcut.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'src', f), path.join(root, 'src', f));
}

process.chdir(root);
const launcher = require(path.join(root, 'src', 'launcher.js'));
const store = require(path.join(root, 'src', 'store.js'));
const util = require(path.join(root, 'src', 'util.js'));

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

// ---- rules engine
const winRules = [{ action: 'allow', os: { name: 'windows' } }];
const osxRules = [{ action: 'allow', os: { name: 'osx' } }];
const disallowRules = [{ action: 'allow', os: { name: 'windows' } }, { action: 'disallow', os: { name: 'windows' } }];
const featRules = [{ action: 'allow', features: { has_custom_res: true } }];

const realOs = process.platform;
check('windows rule on windows', realOs === 'win32' ? launcher.rulesAllow(winRules) === true : launcher.rulesAllow(winRules) === false);
check('osx rule on windows', realOs === 'win32' ? launcher.rulesAllow(osxRules) === false : true);
check('disallow overrides allow', launcher.rulesAllow(disallowRules) === false);
check('no rules means allowed', launcher.rulesAllow(undefined) === true);
check('feature rule respected', launcher.rulesAllow(featRules, { has_custom_res: true }) === true);
check('feature rule denied', launcher.rulesAllow(featRules, {}) === false);

// ---- offline uuid: same name -> same uuid, valid md5 format
const u1 = launcher.offlineUuid('Steve');
const u2 = launcher.offlineUuid('Steve');
const u3 = launcher.offlineUuid('Alex');
check('offline uuid deterministic', u1 === u2);
check('offline uuid differs per name', u1 !== u3);
check('offline uuid is 32 hex chars', /^[0-9a-f]{32}$/.test(u1));

// ---- maven path helper
const p1 = launcher.libRelPath ? null : null; // (not exported; exercised via configs below)

// ---- store: memory clamp
const sysRam = store.systemRamMb();
check('clampMemory caps at 75% RAM', store.clampMemory(999999) <= Math.floor(sysRam * 0.75));
check('clampMemory floors at 1024', store.clampMemory(1) === 1024);
check('clampMemory passes sane values', store.clampMemory(2048) === 2048);

// ---- util: pool runs everything, respects concurrency
(async () => {
  let ran = 0;
  let maxActive = 0;
  let active = 0;
  await util.pool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await util.sleep(5);
    active--;
    ran++;
  });
  check('pool ran all items', ran === 8);
  check('pool respects concurrency limit', maxActive <= 3);

  // ---- download retry: bad URL fails after retries (fast: no real attempts on 0 attempts)
  let attempts = 0;
  const goodServer = null; // no server needed; we test failure path only
  try {
    await util.download('http://127.0.0.1:1/nope', path.join(root, 'nope.bin'));
    check('download to dead port fails', false);
  } catch (_) {
    check('download to dead port fails', true);
  }

  // ---- logger: secret masking
  const logger = require(path.join(root, 'src', 'logger.js'));
  logger.init(path.join(root, 'appdata', 'logs'));
  const maskedJwt = logger.mask('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end');
  check('logger masks JWTs', !maskedJwt.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi') && maskedJwt.includes('JWT-***'));
  const maskedBearer = logger.mask('Authorization: Bearer abc123secretXYZ');
  check('logger masks Bearer tokens', maskedBearer.includes('Bearer ***') && !maskedBearer.includes('abc123secretXYZ'));
  const clean = logger.mask('Minecraft exited with code 0');
  check('logger leaves normal text alone', clean === 'Minecraft exited with code 0');
  check('logger writes to file', fs.existsSync(path.join(root, 'appdata', 'logs', 'darklauncher.log')));
  check('logger keeps recent lines', logger.recentLines().length > 0);

  // ---- retry classification
  const e500 = new util.HttpError(500, 'server boom');
  const e404 = new util.HttpError(404, 'missing');
  const eTimeout = new Error('Timeout fetching http://x');
  check('5xx is retryable', util.isRetryable(e500) === true);
  check('404 is not retryable', util.isRetryable(e404) === false);
  check('timeout is retryable', util.isRetryable(eTimeout) === true);

  // ---- human formatting
  check('humanBytes formats', util.humanBytes(1536) === '1.5 KB' && util.humanBytes(0) === '0 B');
  check('humanDuration formats', util.humanDuration(65000) === '1m 5s');

  // ---- store: corrupt JSON recovery + atomic write
  const corruptFile = path.join(root, 'appdata', 'corrupt.json');
  fs.writeFileSync(corruptFile, '{not valid json!!');
  const recovered = store.readJson(corruptFile, { safe: true });
  check('corrupt json returns fallback', recovered && recovered.safe === true);
  check('corrupt json quarantined as .bak', fs.existsSync(corruptFile + '.bak'));
  const goodFile = path.join(root, 'appdata', 'good.json');
  store.writeJson(goodFile, { hello: 'world' });
  check('atomic write round-trips', store.readJson(goodFile, {}).hello === 'world');

  // ---- play history
  store.recordPlayStart('1.0-test');
  store.recordPlayEnd('1.0-test');
  check('play history recorded', typeof store.lastPlayedAt('1.0-test') === 'number');

  // ---- fabric helpers
  const fabric = require(path.join(root, 'src', 'fabric.js'));
  check('fabric version id format', fabric.versionId('0.16.5', '1.21.4') === 'fabric-loader-0.16.5-1.21.4');
  check('fabric maven rel path', fabric.mavenRelPath('net.fabricmc:fabric-loader:0.16.5') ===
    path.join('net', 'fabricmc', 'fabric-loader', '0.16.5', 'fabric-loader-0.16.5.jar'));
  check('fabric maven path rejects garbage', (() => { try { fabric.mavenRelPath('badname'); return false; } catch (_) { return true; } })());

  // ---- instances: servers
  const instances = require(path.join(root, 'src', 'instances.js'));
  const added = instances.addServer({ name: 'Hypixel', host: 'mc.hypixel.net' });
  check('server added with default port', added.ok && added.server.port === 25565);
  check('server requires host', instances.addServer({ name: 'x' }).ok === false);
  check('server list persisted', instances.getServers().some(s => s.host === 'mc.hypixel.net'));
  instances.removeServer(added.server.id);
  check('server removed', !instances.getServers().some(s => s.id === added.server.id));

  // ---- instances: version management
  check('deleteVersion rejects weird ids', instances.deleteVersion('..\\evil').ok === false);
  check('deleteVersion rejects missing', instances.deleteVersion('ghost-version').ok === false);
  const vdir = path.join(root, 'appdata', 'versions', 'deleteme-test');
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 'deleteme-test.json'), JSON.stringify({ id: 'deleteme-test', mainClass: 'x' }));
  const detailed = instances.listInstalledDetailed().find(v => v.id === 'deleteme-test');
  check('detailed list sees fake version', !!detailed && detailed.complete === false);
  check('deleteVersion removes dir', instances.deleteVersion('deleteme-test').ok === true && !fs.existsSync(vdir));

  // ---- modrinth path safety
  const modrinth = require(path.join(root, 'src', 'modrinth.js'));
  check('removeMod blocks traversal', modrinth.removeMod('any-id', '../evil.jar').ok === false);
  check('removeMod blocks dots', modrinth.removeMod('any-id', '..').ok === false);
  check('listInstalled empty for missing dir', modrinth.listInstalled('no-such-instance').length === 0);

  await runNativesTests();
  runLegacyTests();

  console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});

// ---- natives extraction from a hand-built jar
async function runNativesTests() {
  const zlib = require('zlib');
  const zipPath = path.join(root, 'fake-natives.jar');
  {
    const chunks = [];
    const localHeaders = [];
    const central = [];
    let offset = 0;
    const files = [
      { name: 'net/netbeans/example.dll', data: Buffer.from('FAKE_DLL_DATA_123') },
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0') },
      { name: 'com/example/Main.class', data: Buffer.from('CAFE') }
    ];
    for (const f of files) {
      const nameBuf = Buffer.from(f.name);
      const compressed = zlib.deflateRawSync(f.data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(compressed.length, 18);
      lh.writeUInt16LE(nameBuf.length, 26);
      const local = Buffer.concat([lh, nameBuf, compressed]);
      localHeaders.push(local);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(compressed.length, 20);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([ch, nameBuf]));

      offset += local.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    fs.writeFileSync(zipPath, Buffer.concat([...localHeaders, centralBuf, eocd]));
  }

  const fakeVersion = {
    id: '1.0-test',
    assets: 'legacy',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type}',
    libraries: [
      {
        name: 'com.test:fake-natives:1.0',
        downloads: {
          classifiers: {
            'natives-windows': { path: 'com/test/fake-natives/1.0/fake-natives-1.0-natives-windows.jar', sha1: null, url: 'http://invalid/' }
          }
        },
        natives: { windows: 'natives-windows', osx: 'natives-osx', linux: 'natives-linux' },
        rules: [{ action: 'allow', os: { name: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux' } }]
      }
    ]
  };

  const libDest = path.join(root, 'appdata', 'libraries', 'com', 'test', 'fake-natives', '1.0', 'fake-natives-1.0-natives-windows.jar');
  fs.mkdirSync(path.dirname(libDest), { recursive: true });
  fs.copyFileSync(zipPath, libDest);

  fs.mkdirSync(path.join(root, 'appdata', 'versions', '1.0-test'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'appdata', 'versions', '1.0-test', '1.0-test.json'),
    JSON.stringify(fakeVersion)
  );

  const nativesDir = launcher.extractNatives(fakeVersion);
  check('natives extracted dll', fs.existsSync(path.join(nativesDir, 'example.dll')));
  check('meta-inf skipped', !fs.existsSync(path.join(nativesDir, 'MANIFEST.MF')));
  check('class files skipped', !fs.existsSync(path.join(nativesDir, 'Main.class')));

  // ---- buildLaunchConfig smoke test
  store.settings.javaPath = '';
  store.settings.memory = 2048;

  const cfg = launcher.buildLaunchConfig(fakeVersion, {
    auth: { name: 'Steve', uuid: u1, accessToken: 'token123', userType: 'msa' }
  });
  check('config has main class', cfg.args.includes('net.minecraft.client.main.Main'));
  check('config has Xmx2048', cfg.args.some(a => a === '-Xmx2048M'));
  check('config has natives dir flag', cfg.args.some(a => a.startsWith('-Djava.library.path=')));
  check('auth name templated', cfg.args.some(a => a === 'Steve'));
  check('auth token templated', cfg.args.some(a => a === 'token123'));
  check('cwd is game dir', cfg.cwd === path.join(root, 'appdata', 'game'));
  // A plain artifact library must land on the classpath; the natives-only
  // classifier jar must NOT (only its natives get extracted).
  fakeVersion.libraries.push({
    name: 'com.test:fake-plain:1.0',
    downloads: { artifact: { path: 'com/test/fake-plain/1.0/fake-plain-1.0.jar', sha1: null, url: 'http://invalid/' } }
  });
  const cfg3 = launcher.buildLaunchConfig(fakeVersion, { auth: { name: 'Steve', uuid: u1, accessToken: 'token123', userType: 'msa' } });
  const cpIdx = cfg3.args.indexOf('-cp');
  const cpArg = cpIdx >= 0 ? cfg3.args[cpIdx + 1] : '';
  check('artifact lib on classpath', cpArg.includes('fake-plain-1.0.jar'));
  check('natives-only jar not on classpath', !cpArg.includes('fake-natives-1.0-natives'));

  // fullscreen flag
  store.settings.fullscreen = true;
  const cfg2 = launcher.buildLaunchConfig(fakeVersion, { auth: { name: 'S', uuid: u1, accessToken: '0', userType: 'legacy' } });
  check('fullscreen flag appended', cfg2.args.includes('--fullscreen'));
  store.settings.fullscreen = false;
}

// ---- legacy library support (no downloads metadata)
function runLegacyTests() {
  const legacyVersion = {
    id: 'legacy-test',
    assets: 'legacy',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --accessToken ${auth_access_token}',
    libraries: [
      { name: 'org.legacy:old-lib:2.0', url: 'https://libraries.minecraft.net/' }
    ]
  };
  let ok = true;
  try {
    const cfg = launcher.buildLaunchConfig(legacyVersion, { auth: { name: 'A', uuid: u1, accessToken: 'x', userType: 'legacy' } });
    const i = cfg.args.indexOf('-cp');
    const cp = i >= 0 ? cfg.args[i + 1] : '';
    ok = cp.includes(path.join('org', 'legacy', 'old-lib', '2.0').slice(0, 12));
  } catch (e) {
    ok = false;
  }
  check('legacy library resolved into classpath', ok);
}

// ---- desktop shortcut self-repair logic
{
  const shortcut = require(path.join(root, 'src', 'shortcut.js'));
  const fakeBat = 'C:\\Apps\\Darklauncher\\Darklauncher.bat';
  const fakeIco = 'C:\\Apps\\Darklauncher\\build\\darklauncher-icon.ico';

  // Build a real .lnk via the same PowerShell path the app uses, then verify
  // the parser round-trips it. Skipped silently on non-Windows CI.
  if (process.platform === 'win32') {
    const tmpLnkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlk-lnk-'));
    const lnkPath = path.join(tmpLnkDir, 'Darklauncher.lnk');
    // The target must EXIST: Windows only writes LocalBasePath for
    // resolvable targets (exactly why iconless real shortcuts still parse).
    const realBat = path.join(tmpLnkDir, 'Darklauncher.bat');
    fs.writeFileSync(realBat, '@echo off\r\n');
    const otherBat = path.join(tmpLnkDir, 'Other.bat');
    fs.writeFileSync(otherBat, '@echo off\r\n');
    const script = shortcut.buildShortcutPsScript(realBat, fakeIco).replace(
      /(\$desktop = \[Environment\]::GetFolderPath\('Desktop'\))/,
      "$1\r\n$desktop = '" + tmpLnkDir.replace(/'/g, "''") + "'"
    );
    const { spawnSync } = require('child_process');
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', b64], { timeout: 20000 });
    if (r.status === 0 && fs.existsSync(lnkPath)) {
      const buf = fs.readFileSync(lnkPath);
      const parsed = shortcut.parseLinkStrings(buf);
      const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase() || shortcut.sameFile(a, b);
      check('lnk round-trip: target parsed', parsed && eq(parsed.localBasePath, realBat));
      check('lnk round-trip: icon parsed', !!(parsed && parsed.iconLocation && parsed.iconLocation.startsWith(fakeIco)));
      check('healthy lnk needs no repair', shortcut.shortcutNeedsRepair(buf, realBat, fakeIco) === null);
      check('wrong icon detected', shortcut.shortcutNeedsRepair(buf, realBat, 'C:\\other\\x.ico') === 'icon');
      check('wrong target detected', shortcut.shortcutNeedsRepair(buf, otherBat, fakeIco) === 'target');
    } else {
      console.log('  (skip) could not create test .lnk via PowerShell');
    }
    try { fs.rmSync(tmpLnkDir, { recursive: true, force: true }); } catch (_) {}
  }

  // Garbage input must read as "needs repair", never throw.
  check('garbage buffer -> unreadable', shortcut.shortcutNeedsRepair(Buffer.from([1, 2, 3]), fakeBat, fakeIco) === 'unreadable');
  check('empty buffer -> unreadable', shortcut.shortcutNeedsRepair(Buffer.alloc(0), fakeBat, fakeIco) === 'unreadable');

  // PS command must be encoded (no raw quoting pitfalls).
  const cmd = shortcut.buildShortcutCommand(fakeBat, fakeIco);
  check('ps command uses EncodedCommand', cmd[1] === '-NoProfile' && cmd[2] === '-EncodedCommand' && typeof cmd[3] === 'string' && cmd[3].length > 40);
  check('ps script carries icon path', shortcut.buildShortcutPsScript(fakeBat, fakeIco).includes('darklauncher-icon.ico'));

  // Non-Windows must be a clean no-op.
  const nop = shortcut.ensureDesktopShortcut({ isWindows: false });
  check('non-windows no-op', nop.skipped === true && nop.reason === 'not-windows');
}
