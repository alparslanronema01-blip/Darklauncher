'use strict';

// Microsoft OAuth device-code flow + offline accounts.
// - Tokens are refreshed proactively when they expire within 5 minutes
// - Refresh failures are retried once before giving up
// - Account payloads exposed to the renderer never contain raw tokens

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const store = require('./store');
const log = require('./logger').child('auth');

const CLIENT_ID = '00000000402b5328'; // official Minecraft launcher client id (public, widely reused)
const SCOPE = 'XboxLive.signin offline_access';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const isForm = typeof body === 'string';
    const data = isForm ? body : JSON.stringify(body);
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }, headers || {})
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        getJson(res.headers.location, token).then(resolve, reject);
        return;
      }
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function deviceCodeStart() {
  const res = await postJson(
    `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`,
    new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString()
  );
  if (!res.json.device_code) throw new Error(res.json.error_description || 'Device code request failed');
  return res.json;
}

async function deviceCodePoll(dc) {
  // Returns account object on success, null while pending.
  const res = await postJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: dc.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });

  if (res.json.access_token) {
    return finishLogin(res.json);
  }
  if (res.json.error === 'authorization_pending' || res.json.error === 'slow_down') return null;
  throw new Error(res.json.error_description || res.json.error || 'Login failed');
}

async function finishLogin(tokens) {
  // Xbox Live
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${tokens.access_token}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });

  // XSTS
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { UserTokens: [xbl.json.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });

  const uhs = xsts.json.DisplayClaims && xsts.json.DisplayClaims.xui[0].uhs;

  // Minecraft login
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}`
  });

  // Profile
  const profile = await getJson('https://api.minecraftservices.com/minecraft/profile', mc.json.access_token);
  if (!profile.id && profile.error) {
    throw new Error(profile.error + ' ' + (profile.errorMessage || ''));
  }

  const account = {
    type: 'msa',
    name: profile.name,
    uuid: formatUuid(profile.id),
    accessToken: mc.json.access_token,
    msAccessToken: tokens.access_token,
    msRefreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (mc.json.expires_in || 86400) * 1000
  };
  saveAccount(account);
  return account;
}

function formatUuid(noDashes) {
  if (!noDashes || noDashes.length !== 32) return noDashes || '';
  return `${noDashes.slice(0, 8)}-${noDashes.slice(8, 12)}-${noDashes.slice(12, 16)}-${noDashes.slice(16, 20)}-${noDashes.slice(20)}`;
}

function saveAccount(account) {
  const data = store.getAccounts();
  const i = data.accounts.findIndex(a => a.uuid === account.uuid);
  if (i >= 0) data.accounts[i] = account; else data.accounts.push(account);
  data.active = account.uuid;
  store.saveAccounts(data);
  log.info(`account saved: ${account.name} (${account.type})`);
}

function getActiveAccount() {
  const data = store.getAccounts();
  return data.accounts.find(a => a.uuid === data.active) || null;
}

// Safe view of an account for IPC/UI: strips every token field.
function publicAccount(account) {
  if (!account) return null;
  const { accessToken, msAccessToken, msRefreshToken, ...safe } = account;
  return safe;
}

// Public list for the accounts panel.
function listAccountsPublic() {
  return store.getAccounts().accounts.map(publicAccount);
}

function needsRefresh(account) {
  return !!(
    account && account.type === 'msa' && account.msRefreshToken &&
    (!account.expiresAt || account.expiresAt < Date.now() + TOKEN_REFRESH_MARGIN_MS)
  );
}

async function refreshTokens(account, attempt = 0) {
  // Best-effort silent refresh; returns original if it fails.
  if (!account || !account.msRefreshToken) return account;
  try {
    const res = await postJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: account.msRefreshToken,
      grant_type: 'refresh_token'
    }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
    if (!res.json.access_token) {
      throw new Error(res.json.error_description || 'refresh returned no token');
    }
    const fresh = await finishLogin(res.json);
    log.info(`tokens refreshed for ${account.name}`);
    return fresh;
  } catch (e) {
    log.warn(`token refresh failed (attempt ${attempt + 1}): ${e.message}`);
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return refreshTokens(account, attempt + 1);
    }
    return account; // fall back to the stale account; game may still work
  }
}

// Ensure the active MSA account has a fresh access token before launching.
async function ensureFreshToken(account) {
  if (!needsRefresh(account)) return account;
  log.info(`token expires soon; refreshing proactively for ${account.name}`);
  return refreshTokens(account);
}

function offlineUuid(name) {
  return crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest('hex');
}

function setOffline(name) {
  const account = {
    type: 'offline',
    name,
    uuid: offlineUuid(name),
    accessToken: '0',
    userType: 'legacy'
  };
  saveAccount(account);
  return account;
}

module.exports = {
  deviceCodeStart,
  deviceCodePoll,
  getActiveAccount,
  listAccountsPublic,
  publicAccount,
  ensureFreshToken,
  needsRefresh,
  setOffline,
  refreshTokens,
  offlineUuid
};
