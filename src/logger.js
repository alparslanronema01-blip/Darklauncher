'use strict';

// Structured, leveled logger shared by every backend module.
// - Writes to stdout AND to appdata/logs/darklauncher-YYYY-MM-DD.log
// - Keeps a ring buffer of recent entries (served to the UI via IPC)
// - Masks secrets (tokens, JWTs) before anything is written anywhere
// - Simple size-based rotation: darklauncher.log -> darklauncher.log.old

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const RING_MAX = 600;
const ROTATE_BYTES = 5 * 1024 * 1024;

let logDir = null;
const ring = [];

// ------------------------------------------------------------ secret masking
const SECRET_PATTERNS = [
  // JWTs (three base64url segments)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'JWT-***'],
  // Authorization headers
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***'],
  // token-style query params and json keys
  [/((?:access|refresh|auth)[_-]?token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, '$1***'],
  [/identityToken["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, 'identityToken:***'],
  // XBL3.0 identity tokens
  [/XBL3\.0\s+x=[^;\s]+;/g, 'XBL3.0 x=***;']
];

function mask(str) {
  let out = String(str);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------- formatting
function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatLine(level, scope, parts) {
  const msg = parts.map((p) => {
    if (p instanceof Error) return p.stack || p.message;
    if (typeof p === 'object') {
      try { return JSON.stringify(p); } catch (_) { return String(p); }
    }
    return String(p);
  }).join(' ');
  return `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${mask(msg)}`;
}

// ---------------------------------------------------------------- file sink
function currentLogFile() {
  return path.join(logDir, 'darklauncher.log');
}

function rotateIfNeeded() {
  try {
    const file = currentLogFile();
    const st = fs.statSync(file);
    if (st.size > ROTATE_BYTES) {
      try { fs.unlinkSync(file + '.old'); } catch (_) { /* no old yet */ }
      fs.renameSync(file, file + '.old');
    }
  } catch (_) { /* nothing to rotate */ }
}

function appendFile(line) {
  if (!logDir) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(currentLogFile(), line + '\n');
  } catch (_) { /* disk issues must never crash the app */ }
}

// ---------------------------------------------------------------- emit
function emit(level, scope, parts) {
  const line = formatLine(level, scope, parts);

  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');

  appendFile(line);
}

function makeScope(scope) {
  return {
    debug: (...a) => LEVELS.debug >= MIN_LEVEL && emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    mask
  };
}

let MIN_LEVEL = LEVELS.debug;

function init(dir, opts) {
  logDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  if (opts && opts.minLevel && LEVELS[opts.minLevel] !== undefined) {
    MIN_LEVEL = LEVELS[opts.minLevel];
  }
  emit('info', 'logger', [`Logging initialised (dir: ${dir})`]);
}

module.exports = {
  init,
  mask,
  makeScope,
  child: makeScope,
  recentLines: () => ring.slice(),
  logFile: () => (logDir ? currentLogFile() : null),
  logDir: () => logDir
};
