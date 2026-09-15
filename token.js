/*
 * Studio OAuth token manager.
 *
 * Bluebeam Studio uses the OAuth2 authorization-code flow with the
 * `offline_access` scope (see api-1.yaml securitySchemes). There is NO
 * client-credentials grant, so the server can't mint tokens from nothing — but
 * `offline_access` yields a long-lived refresh token, and this module trades
 * that refresh token for short-lived access tokens automatically.
 *
 * Three ways to supply credentials, in priority order:
 *   1. OAuth refresh  — BLUEBEAM_CLIENT_ID + BLUEBEAM_CLIENT_SECRET + a refresh
 *      token (from BLUEBEAM_REFRESH_TOKEN, or obtained once via /auth/login).
 *      The server refreshes on expiry and on any 401. This is the hands-off mode.
 *   2. Static token   — BLUEBEAM_TOKEN, a token you paste in yourself. Used only
 *      when OAuth creds aren't configured. Expires; you re-paste it.
 *   3. None           — calls fail with a clear message.
 *
 * Refresh-token rotation: if Studio returns a new refresh_token on refresh, we
 * keep it in memory and best-effort persist it to TOKEN_STORE_PATH so in-instance
 * restarts survive. On a fresh cold start the env refresh token is used again;
 * if your provider hard-rotates (invalidates the old one immediately), re-authorize
 * via /auth/login or paste a current refresh token. See README.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = (process.env.BLUEBEAM_API_BASE || 'https://api.bluebeam.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.BLUEBEAM_CLIENT_ID || '';
const CLIENT_SECRET = process.env.BLUEBEAM_CLIENT_SECRET || '';
const STATIC_TOKEN = process.env.BLUEBEAM_TOKEN || '';
const STORE_PATH = process.env.TOKEN_STORE_PATH || path.join(os.tmpdir(), 'bh-mv-token.json');

const mem = {
  accessToken: '',
  expiresAt: 0,
  refreshToken: process.env.BLUEBEAM_REFRESH_TOKEN || '',
};

(function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (j && j.refreshToken) mem.refreshToken = j.refreshToken; // stored (possibly rotated) token wins
  } catch { /* no store yet */ }
})();

function saveStore() {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify({ refreshToken: mem.refreshToken }), 'utf8'); }
  catch (e) { console.warn('token store write failed (non-fatal):', e.message); }
}

function haveOAuth() { return !!(CLIENT_ID && CLIENT_SECRET && mem.refreshToken); }

async function postToken(params) {
  const res = await fetch(API_BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { ok: res.ok, status: res.status, json };
}

function applyTokenResponse(json) {
  mem.accessToken = json.access_token;
  const ttl = Number(json.expires_in) || 3600;
  mem.expiresAt = Date.now() + Math.max(30, ttl - 60) * 1000; // refresh a minute early
  if (json.refresh_token && json.refresh_token !== mem.refreshToken) {
    mem.refreshToken = json.refresh_token; // rotation
    saveStore();
  }
}

async function refresh() {
  const r = await postToken({
    grant_type: 'refresh_token',
    refresh_token: mem.refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  if (!r.ok || !r.json || !r.json.access_token) {
    const e = new Error('Studio token refresh failed (' + r.status + ')');
    e.detail = r.json;
    throw e;
  }
  applyTokenResponse(r.json);
  return mem.accessToken;
}

// Exchange a one-time authorization code (from /auth/login) for tokens.
async function exchangeCode(code, redirectUri) {
  const r = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri,
  });
  if (!r.ok || !r.json || !r.json.access_token) {
    const e = new Error('Authorization code exchange failed (' + r.status + ')');
    e.detail = r.json;
    throw e;
  }
  applyTokenResponse(r.json);
  return r.json;
}

// Return a usable access token, refreshing if needed. `force` bypasses the cache.
async function getAccessToken(force) {
  if (haveOAuth()) {
    if (!force && mem.accessToken && Date.now() < mem.expiresAt) return mem.accessToken;
    return refresh();
  }
  return STATIC_TOKEN;
}

function status() {
  const mode = haveOAuth() ? 'oauth-refresh' : (STATIC_TOKEN ? 'static-token' : 'none');
  return {
    mode,
    ready: mode !== 'none',
    hasRefreshToken: !!mem.refreshToken,
    hasClientCreds: !!(CLIENT_ID && CLIENT_SECRET),
    accessTokenCached: !!mem.accessToken,
    expiresInSeconds: mem.expiresAt ? Math.max(0, Math.round((mem.expiresAt - Date.now()) / 1000)) : null,
  };
}

function authorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'offline_access profile openid',
  });
  if (state) p.set('state', state);
  return API_BASE + '/oauth2/authorize?' + p.toString();
}

module.exports = {
  getAccessToken, refresh, exchangeCode, status, haveOAuth, authorizeUrl,
  config: { CLIENT_ID, CLIENT_SECRET, API_BASE },
};
