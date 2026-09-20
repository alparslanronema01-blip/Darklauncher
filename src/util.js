'use strict';

// Shared network + concurrency helpers:
// - fetchJson / download with hard timeouts, redirects and a real User-Agent
// - downloadWithRetry: exponential backoff with jitter, honors Retry-After
// - pool: bounded-concurrency job runner with error collection
// - humanBytes / humanDuration for UI formatting

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const log = require('./logger').child('net');

const UA = `Darklauncher/1.1 (${process.platform}; ${process.arch})`;
const DEFAULT_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------- core fetch

function requestOnce(url, { headers, timeout } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(url, {
      headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*' }, headers || {})
    }, (res) => {
      done(resolve, res);
    });
    req.on('error', (e) => done(reject, e));
    req.setTimeout(timeout || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout after ${timeout || DEFAULT_TIMEOUT_MS}ms: ${url}`));
      done(reject, new Error(`Timeout: ${url}`));
    });
  });
}

// Reads a response stream to a string with a size cap.
function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    res.on('data', (c) => {
      size += c.length;
      if (maxBytes && size > maxBytes) {
        res.destroy();
        reject(new Error(`Response exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function fetchJson(url, opts) {
  let redirects = 0;
  let current = url;
  while (true) {
    const res = await requestOnce(current, opts);
    if (opts && typeof opts.onResponse === 'function') {
      try { opts.onResponse(res); } catch (_) { /* hook must not break fetch */ }
    }
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (++redirects > 5) throw new Error(`Too many redirects for ${url}`);
      current = new URL(res.headers.location, current).href;
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new HttpError(res.statusCode, `HTTP ${res.statusCode} for ${current}`);
    }
    const buf = await readBody(res, 64 * 1024 * 1024);
    try { return JSON.parse(buf.toString('utf8')); }
    catch (e) { throw new Error(`Invalid JSON from ${current}: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- download

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (u, redirects) => {
      if (redirects > 5) { reject(new Error(`Too many redirects for ${url}`)); return; }
      const u2 = new URL(u);
      const mod = u2.protocol === 'http:' ? http : https;
      const req = mod.get(u, { headers: { 'User-Agent': UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          request(new URL(res.headers.location, u).href, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new HttpError(res.statusCode, `HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;
        let lastTick = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (c) => {
          done += c.length;
          if (onProgress && total) {
            const now = Date.now();
            if (now - lastTick > 100) { lastTick = now; onProgress(done / total); }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', (e) => { file.close(() => { cleanup(dest); reject(e); }); });
        res.on('error', (e) => { file.close(() => { cleanup(dest); reject(e); }); });
      });
      req.on('error', (e) => { cleanup(dest); reject(e); });
      req.setTimeout(30000, () => {
        req.destroy();
        cleanup(dest);
        reject(new Error(`Timeout fetching ${u}`));
      });
    };
    request(url, 0);
  });
}

function cleanup(dest) {
  try { fs.unlinkSync(dest); } catch (_) { /* not created yet */ }
}

function isRetryable(err) {
  if (err instanceof HttpError) {
    // 408 request timeout, 429 rate limit, all 5xx
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  if (err && typeof err.message === 'string') {
    return /timeout|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket hang up/i.test(err.message);
  }
  return false;
}

// Download with retry + exponential backoff + jitter. Honors Retry-After.
async function downloadWithRetry(url, dest, onProgress, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      let delay = 400 * Math.pow(2, i - 1);
      if (lastErr instanceof HttpError && lastErr.retryAfterMs) delay = Math.max(delay, lastErr.retryAfterMs);
      delay += Math.random() * delay * 0.3; // jitter avoids thundering herd
      log.debug(`retry ${i}/${attempts - 1} for ${path.basename(dest)} in ${Math.round(delay)}ms (${lastErr && lastErr.message})`);
      await sleep(delay);
    }
    try {
      await download(url, dest, onProgress);
      return dest;
    } catch (e) {
      lastErr = e;
      cleanup(dest);
      if (!isRetryable(e) && i < attempts - 1) {
        log.debug(`non-retryable failure for ${path.basename(dest)}: ${e.message}`);
        break;
      }
    }
  }
  throw lastErr;
}

class HttpError extends Error {
  constructor(status, message, retryAfterMs) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Run async jobs with limited concurrency. onDone(job, i) after each completes.
async function pool(items, limit, worker, onDone) {
  let next = 0;
  let finished = 0;
  const total = items.length;
  async function run() {
    while (next < total) {
      const i = next++;
      await worker(items[i], i);
      finished++;
      if (onDone) onDone(items[i], finished, total);
    }
  }
  const n = Math.max(1, Math.min(limit, Math.max(total, 1)));
  await Promise.all(Array.from({ length: n }, run));
}

// ---------------------------------------------------------------- formatting

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

module.exports = {
  fetchJson,
  download,
  downloadWithRetry,
  sleep,
  pool,
  UA,
  HttpError,
  isRetryable,
  humanBytes,
  humanDuration
};
