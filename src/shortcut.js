'use strict';

// Desktop shortcut management. Ensures the "Darklauncher" desktop shortcut
// exists and always points at Darklauncher.bat with the launcher icon.
// Runs automatically at app start (self-repair), so installations shared via
// GitHub (zip copy, clone) get a proper icon without any extra steps.
//
// Why: a .bat has no icon of its own — a shortcut made with right-click
// "Create shortcut" shows the generic gear icon. Only a shortcut whose
// IconLocation points at our .ico shows the launcher logo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SHORTCUT_NAME = 'Darklauncher.lnk';

// --------------------------------------------------------------- paths

function shortcutPath() {
  return path.join(os.homedir(), 'Desktop', SHORTCUT_NAME);
}

// The real (possibly OneDrive-redirected) Desktop. The writer script uses
// [Environment]::GetFolderPath('Desktop'); the read side must resolve the
// same directory or a redirected desktop would look "missing" every start.
let desktopDirCache = null;
function resolveDesktopDir() {
  if (desktopDirCache) return desktopDirCache;
  let dir = path.join(os.homedir(), 'Desktop');
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('powershell', [
        '-NoProfile', '-Command', '[Environment]::GetFolderPath(\'Desktop\')'
      ], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
      const out = r.status === 0 ? String(r.stdout || '').trim() : '';
      if (out) dir = out;
    } catch (_) { /* keep fallback */ }
  }
  desktopDirCache = dir;
  return dir;
}

// ------------------------------------------------------- .lnk parsing
// Minimal read-only MS-SHLLINK parser: just enough to read LinkInfo's
// LocalBasePath and the ICON_LOCATION string. Any surprise -> null, which
// callers treat as "needs repair" (safe: we rewrite the whole shortcut).

function firstNul(buf, from, to) {
  for (let i = from; i < to && i < buf.length; i++) {
    if (buf[i] === 0) return i;
  }
  return -1;
}

function parseLinkStrings(buf) {
  try {
    if (!buf || buf.length < 76) return null;
    const flags = buf.readUInt32LE(20);
    const isUnicode = (flags & 0x80) !== 0;
    let p = 76;
    let localBasePath = null;

    if (flags & 0x01) { // LinkTargetIDList present -> skip it
      if (p + 2 > buf.length) return null;
      const idListSize = buf.readUInt16LE(p);
      p += 2 + idListSize;
      if (p > buf.length) return null;
    }

    if (flags & 0x02) { // LinkInfo
      if (p + 4 > buf.length) return null;
      const size = buf.readUInt32LE(p);
      if (size < 4 || p + size > buf.length) return null;
      const end = p + size;
      if (size >= 0x1c && p + 0x1c <= end) {
        const liFlags = buf.readUInt32LE(p + 8);
        // Offsets are relative to the LinkInfo start: [size, headerSize,
        // flags, volumeIdOff, localBasePathOff, netLinkOff, commonSuffixOff].
        const localOff = buf.readUInt32LE(p + 16);
        // VolumeIDAndLocalBasePath: ANSI LocalBasePath at p + localOff.
        if ((liFlags & 0x01) && localOff > 0 && localOff < size) {
          const abs = p + localOff;
          const nul = firstNul(buf, abs, end);
          if (nul > abs) localBasePath = buf.toString('latin1', abs, nul);
        }
      }
      p = end;
    }

    const readStr = () => {
      if (isUnicode) {
        if (p + 2 > buf.length) return null;
        const cc = buf.readUInt16LE(p);
        p += 2;
        if (p + cc * 2 > buf.length) return null;
        const s = buf.toString('utf16le', p, p + cc * 2);
        p += cc * 2;
        return s.replace(/\0.*$/, '');
      }
      if (p + 1 > buf.length) return null;
      const cc = buf[p];
      p += 1;
      if (p + cc > buf.length) return null;
      const s = buf.toString('latin1', p, p + cc);
      p += cc;
      return s.replace(/\0.*$/, '');
    };

    const strings = {};
    if (flags & 0x04) strings.name = readStr();
    if (flags & 0x08) strings.relativePath = readStr();
    if (flags & 0x10) strings.workingDir = readStr();
    if (flags & 0x20) strings.arguments = readStr();
    if (flags & 0x40) strings.iconLocation = readStr();
    strings.localBasePath = localBasePath;
    return strings;
  } catch (_) {
    return null;
  }
}

function extractIcoLocation(buf) {
  const parsed = parseLinkStrings(buf);
  return parsed ? parsed.iconLocation || null : null;
}

// --------------------------------------------------------- comparisons

function normalizeWinPath(p) {
  return String(p || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .trim()
    .toLowerCase();
}

// True when a and b refer to the same existing file. Realpath resolves
// 8.3 short names (ADMINI~1) to long names, so a shortcut written by
// PowerShell (long paths) still compares equal to __dirname-derived
// paths that came from a short-name TEMP/extract location.
function sameFile(a, b) {
  const na = normalizeWinPath(a);
  const nb = normalizeWinPath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  try {
    if (normalizeWinPath(fs.realpathSync(a)) === normalizeWinPath(fs.realpathSync(b))) return true;
  } catch (_) { /* fall through to identity check */ }
  // realpath does not expand 8.3 short names (ADMINI~1). Compare NTFS file
  // identity instead: the same file under both path forms shares dev+ino.
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n;
  } catch (_) {
    return false; // one side missing -> not the same file
  }
}

// Returns null when the shortcut is good, otherwise why it needs repair:
// 'unreadable' | 'icon' | 'target'.
function shortcutNeedsRepair(buf, batPath, iconPath) {
  const parsed = parseLinkStrings(buf);
  if (!parsed) return 'unreadable';
  const ico = parsed.iconLocation;
  if (!ico) return 'icon';
  const icoPath = ico.replace(/,\s*\d+\s*$/, '');
  if (!sameFile(icoPath, iconPath)) return 'icon';
  if (parsed.localBasePath &&
      !sameFile(parsed.localBasePath, batPath)) {
    return 'target';
  }
  return null;
}

// ---------------------------------------------------- shortcut writing

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function buildShortcutPsScript(batPath, iconPath) {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$ws = New-Object -ComObject WScript.Shell`,
    `$desktop = [Environment]::GetFolderPath('Desktop')`,
    `$lnk = $ws.CreateShortcut((Join-Path $desktop ${psQuote(SHORTCUT_NAME)}))`,
    `$lnk.TargetPath = ${psQuote(batPath)}`,
    `$lnk.WorkingDirectory = ${psQuote(path.dirname(batPath))}`,
    `$lnk.IconLocation = ${psQuote(`${iconPath},0`)}`,
    `$lnk.Description = 'Darklauncher - Minecraft Launcher'`,
    `$lnk.Save()`,
    `Start-Process ie4uinit -ArgumentList '-show' -WindowStyle Hidden`
  ].join('\r\n');
}

// EncodedCommand avoids every quoting/unicode pitfall with user paths.
function buildShortcutCommand(batPath, iconPath) {
  const b64 = Buffer.from(buildShortcutPsScript(batPath, iconPath), 'utf16le').toString('base64');
  return ['powershell', '-NoProfile', '-EncodedCommand', b64];
}

// ------------------------------------------------------------- main API

// Checks the desktop shortcut and creates/repairs it when needed.
// Returns { created, repaired, skipped, reason, error }.
function ensureDesktopShortcut(opts = {}) {
  const isWindows = opts.isWindows !== undefined ? opts.isWindows : process.platform === 'win32';
  const batPath = opts.batPath || path.join(__dirname, '..', 'Darklauncher.bat');
  const iconPath = opts.iconPath || path.join(__dirname, '..', 'build', 'darklauncher-icon.ico');
  const lnkPath = opts.lnkPath || path.join(resolveDesktopDir(), SHORTCUT_NAME);
  const result = { created: false, repaired: false, skipped: false, reason: null, error: null };

  if (!isWindows) {
    result.skipped = true;
    result.reason = 'not-windows';
    return result;
  }

  let existing = null;
  try { existing = fs.readFileSync(lnkPath); } catch (_) { existing = null; }

  if (existing && !shortcutNeedsRepair(existing, batPath, iconPath)) {
    result.skipped = true;
    result.reason = 'ok';
    return result;
  }

  if (!fs.existsSync(batPath)) {
    result.skipped = true;
    result.reason = 'bat-missing';
    return result;
  }
  if (!fs.existsSync(iconPath)) {
    result.skipped = true;
    result.reason = 'icon-missing';
    return result;
  }

  const args = buildShortcutCommand(batPath, iconPath);
  const r = spawnSync(args[0], args.slice(1), { timeout: 20000, windowsHide: true });
  if (r.error) {
    result.error = r.error.message;
    return result;
  }
  if (r.status !== 0) {
    result.error = `powershell exit ${r.status}`;
    return result;
  }

  if (existing) {
    result.repaired = true;
  } else {
    result.created = true;
  }
  result.reason = existing ? 'repair' : 'create';
  return result;
}

module.exports = {
  SHORTCUT_NAME,
  shortcutPath,
  resolveDesktopDir,
  parseLinkStrings,
  extractIcoLocation,
  normalizeWinPath,
  sameFile,
  shortcutNeedsRepair,
  buildShortcutPsScript,
  buildShortcutCommand,
  ensureDesktopShortcut
};
