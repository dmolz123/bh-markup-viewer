/*
 * BH Markup Viewer — backend proxy for the Bluebeam Studio public API.
 *
 * The browser talks ONLY to this server. This server holds the Studio Bearer
 * token (BLUEBEAM_TOKEN) and forwards a whitelisted set of read calls to
 * https://api.bluebeam.com. That removes the three blockers a static page hits:
 * OAuth (token stays server-side), CORS (same-origin /api/*), and CSP.
 *
 * Endpoints (all read-only against Studio, except the snapshot POST that just
 * asks Studio to render an image of the document):
 *   GET  /api/health
 *   GET  /api/load/:sid                      aggregate: session + first file + merged markups + snapshot url
 *   GET  /api/sessions/:sid                  session detail + files
 *   GET  /api/sessions/:sid/files/:fid/markups   merged list + details (adds rect[])
 *   GET  /api/sessions/:sid/files/:fid/snapshot   ensure + return page-image DownloadUrl
 *   GET  /api/image?url=<encoded>            proxy an image (snapshot fallback if it isn't public)
 *
 * Field names come verbatim from the Studio OpenAPI spec (api-1.yaml):
 *   markups (v2):          markupId, pageNumber, subject, status, type, x, y, documentWidth, documentHeight, displayName, email
 *   markups/details (v2):  rect[x1,y1,x2,y2] (PDF pts, bottom-left origin), contents, comments, author, width
 *   snapshot (v1):         Status, DownloadUrl, LastSnapshotTime
 */

const express = require('express');
const path = require('path');
const tokens = require('./token');

const app = express();
const API_BASE = (process.env.BLUEBEAM_API_BASE || 'https://api.bluebeam.com').replace(/\/+$/, '');
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, ''); // optional exact redirect base
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true); // so req.protocol is https behind Render's proxy
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function redirectUri(req) {
  return (APP_BASE_URL || (req.protocol + '://' + req.get('host'))) + '/auth/callback';
}

// ---- Studio API helper -----------------------------------------------------
// Uses the token manager (OAuth refresh or static token) and retries once on a
// 401 after forcing a token refresh.
async function bb(pathPart, opts = {}, _retried) {
  let token;
  try { token = await tokens.getAccessToken(); } catch (e) {
    return { ok: false, status: 401, json: { error: 'Could not obtain a Studio token: ' + e.message, tokenError: e.detail || { error: e.message } } };
  }
  if (!token) {
    return { ok: false, status: 500, json: { error: 'No Studio credentials configured. Set BLUEBEAM_CLIENT_ID/BLUEBEAM_CLIENT_SECRET + a refresh token (or connect via /auth/login), or set BLUEBEAM_TOKEN.' } };
  }
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  // Bluebeam's security also defines a `client_id` header apiKey. Many Studio
  // endpoints require it alongside the Bearer token, so send it when we have it.
  if (tokens.config.CLIENT_ID) headers['client_id'] = tokens.config.CLIENT_ID;

  const res = await fetch(API_BASE + pathPart, { ...opts, headers });
  if (res.status === 401 && !_retried && tokens.haveOAuth()) {
    try { await tokens.getAccessToken(true); } catch { /* fall through to report 401 */ }
    return bb(pathPart, opts, true);
  }
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { ok: res.ok, status: res.status, json };
}

// Bubble a Studio failure to the client with a specific, diagnostic message.
function fail(res, r, where) {
  let hint;
  if (r.json && r.json.tokenError) {
    // The token endpoint itself rejected us (refresh/exchange failed).
    const te = r.json.tokenError;
    const detail = (te && (te.error_description || te.error)) ||
      (te && te.errorDetails && te.errorDetails.message) || 'see detail';
    hint = 'OAuth token request failed (' + detail + '). Check BLUEBEAM_CLIENT_ID / BLUEBEAM_CLIENT_SECRET and that the refresh token is valid for this client.';
  } else if (r.status === 401) {
    hint = tokens.haveOAuth()
      ? 'Studio returned 401 on the API call even with a refreshed access token. Likely a client_id header / scope / permissions mismatch for this Session.'
      : 'Studio returned 401 — no valid access token. You are in static-token mode: put your refresh token in BLUEBEAM_REFRESH_TOKEN (with client id/secret), or paste a current access token in BLUEBEAM_TOKEN.';
  } else if (r.status === 403) {
    hint = 'Studio returned 403 — the account is authenticated but not permitted on this Session (not a member, or insufficient permission).';
  } else if (r.status === 404) {
    hint = 'Studio returned 404 — Session or file not found. Check the Session ID.';
  } else {
    hint = 'Studio API error at ' + where + ' (HTTP ' + r.status + ').';
  }
  res.status(r.status && r.status >= 400 ? r.status : 502).json({ error: hint, status: r.status, where, detail: r.json });
}

// ---- merge markups (list) + details (rect) by `name` -----------------------
// The list DTO (SessionMarkupDto) carries markupId, pageNumber and name; the
// detail DTO (SessionMarkupDetailDto) carries rect/contents but NO markupId and
// NO pageNumber — its stable key is `name` (the markup GUID). So join on `name`.
function mergeMarkups(list, details) {
  list = Array.isArray(list) ? list : [];
  details = Array.isArray(details) ? details : [];
  const detByName = new Map();
  details.forEach((d) => { if (d && d.name != null) detByName.set(String(d.name), d); });
  const samePositional = details.length === list.length; // fallback when names don't line up
  const out = list.map((m, i) => {
    let d = m.name != null ? detByName.get(String(m.name)) : null;
    if (!d && samePositional) d = details[i];
    const rect = d && Array.isArray(d.rect) && d.rect.length === 4 ? d.rect : null;
    return {
      markupId: m.markupId,
      name: m.name,
      pageNumber: m.pageNumber,
      subject: m.subject || (d && d.subject) || '',
      status: m.status || '',
      type: m.type || (d && d.type) || '',
      author: m.displayName || m.email || (d && d.author) || '',
      contents: (d && d.contents) || m.comments || '',
      rect,
    };
  });
  return out.sort((a, b) => {
    if ((a.pageNumber || 0) !== (b.pageNumber || 0)) return (a.pageNumber || 0) - (b.pageNumber || 0);
    return (a.markupId || 0) - (b.markupId || 0);
  });
}

async function getMergedMarkups(sid, fid) {
  const [listR, detR] = await Promise.all([
    bb('/publicapi/v2/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(fid) + '/markups'),
    bb('/publicapi/v2/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(fid) + '/markups/details?limit=1000'),
  ]);
  if (!listR.ok && !detR.ok) return { ok: false, r: listR.ok ? detR : listR };
  return { ok: true, markups: mergeMarkups(listR.json, detR.json) };
}

// Ensure a snapshot exists for a file, poll briefly, return the DownloadUrl (or null).
async function ensureSnapshot(sid, fid) {
  const base = '/publicapi/v1/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(fid) + '/snapshot';
  let r = await bb(base);
  const done = (s) => typeof s === 'string' && s.toLowerCase().startsWith('complete');
  if (r.ok && r.json && done(r.json.Status) && r.json.DownloadUrl) {
    return { status: r.json.Status, downloadUrl: r.json.DownloadUrl };
  }
  // request a fresh render (204 No Content), then poll
  await bb(base, { method: 'POST' });
  for (let i = 0; i < 8; i++) {
    await new Promise((res) => setTimeout(res, 1200));
    r = await bb(base);
    if (r.ok && r.json && done(r.json.Status) && r.json.DownloadUrl) {
      return { status: r.json.Status, downloadUrl: r.json.DownloadUrl };
    }
    if (r.ok && r.json && typeof r.json.Status === 'string' && r.json.Status.toLowerCase().startsWith('error')) {
      return { status: r.json.Status, downloadUrl: null };
    }
  }
  return { status: (r.json && r.json.Status) || 'Pending', downloadUrl: (r.json && r.json.DownloadUrl) || null };
}

// The Studio files endpoint returns SessionFilesDto = { Files: [...], TotalCount }.
function filesArray(json) {
  if (json && Array.isArray(json.Files)) return json.Files;      // SessionFilesDto
  if (Array.isArray(json)) return json;                          // bare array (defensive)
  if (json && Array.isArray(json.ProjectFiles)) return json.ProjectFiles;
  return [];
}
function pickPdf(list) {
  const pdfs = list.filter((f) => /\.pdf$/i.test(f.Name || f.name || ''));
  return (pdfs[0] || list[0] || null);
}

// ---- routes ----------------------------------------------------------------
app.get('/api/health', (req, res) => {
  const auth = tokens.status();
  res.json({ ok: true, apiBase: API_BASE, auth, ready: auth.ready, tokenPresent: auth.ready });
});

// Diagnostics: walks the auth chain and reports where it breaks, WITHOUT leaking
// tokens. Visit /api/diag on the deployed service to see the real failure.
app.get('/api/diag', async (req, res) => {
  const out = { apiBase: API_BASE, auth: tokens.status(), steps: {} };

  // Step 1: can we get an access token at all?
  let token = '';
  try {
    token = await tokens.getAccessToken(true); // force a fresh refresh/exchange
    out.steps.tokenRequest = token
      ? { ok: true, note: 'Obtained an access token (' + tokens.status().mode + ').' }
      : { ok: false, note: 'No credentials configured.' };
  } catch (e) {
    out.steps.tokenRequest = { ok: false, error: e.message, detail: e.detail || null };
    return res.json(out); // can't test API without a token
  }
  if (!token) return res.json(out);

  // Step 2: an authenticated call that doesn't depend on a Session ID.
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  const withCid = tokens.config.CLIENT_ID ? { ...headers, client_id: tokens.config.CLIENT_ID } : headers;
  async function probe(hdrs) {
    try {
      const r = await fetch(API_BASE + '/publicapi/v1/sessions', { headers: hdrs });
      const t = await r.text();
      let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = (t || '').slice(0, 300); }
      return { status: r.status, ok: r.ok, sample: Array.isArray(j) ? ('array[' + j.length + ']') : j };
    } catch (e) { return { error: e.message }; }
  }
  out.steps.listSessions_withClientIdHeader = await probe(withCid);
  out.steps.listSessions_bearerOnly = await probe(headers);
  res.json(out);
});

// CSRF state values pending between /auth/login and /auth/callback.
const pendingStates = new Map(); // state -> expiresAt
function newState() {
  const s = require('crypto').randomBytes(16).toString('hex');
  pendingStates.set(s, Date.now() + 10 * 60 * 1000);
  return s;
}
function consumeState(s) {
  const exp = pendingStates.get(s);
  if (!exp) return false;
  pendingStates.delete(s);
  return Date.now() < exp;
}

// Raw inspection of what Studio returns for a Session (for debugging field shapes).
app.get('/api/raw/:sid', async (req, res) => {
  const sid = req.params.sid;
  const files = await bb('/publicapi/v1/sessions/' + encodeURIComponent(sid) + '/files');
  if (!files.ok) return fail(res, files, 'GET files');
  const list = filesArray(files.json);
  const file = pickPdf(list);
  const fid = file && (file.Id != null ? file.Id : file.id);
  if (!fid) return res.json({ fileId: null, files: list });
  const [mk, det] = await Promise.all([
    bb('/publicapi/v2/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(fid) + '/markups'),
    bb('/publicapi/v2/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(fid) + '/markups/details?limit=1000'),
  ]);
  const arr = (x) => (Array.isArray(x) ? x : []);
  res.json({
    fileId: fid,
    markupsCount: Array.isArray(mk.json) ? mk.json.length : mk.json,
    detailsCount: Array.isArray(det.json) ? det.json.length : det.json,
    markupsSample: arr(mk.json).map((m) => ({ markupId: m.markupId, name: m.name, page: m.pageNumber, subject: m.subject, status: m.status })),
    detailsSample: arr(det.json).map((d) => ({ name: d.name, page: d.pageNumber, subject: d.subject, hasRect: Array.isArray(d.rect), rect: d.rect })),
  });
});

// One-time authorization: send the admin to Studio to grant access.
app.get('/auth/login', (req, res) => {
  if (!tokens.config.CLIENT_ID || !tokens.config.CLIENT_SECRET) {
    return res.status(400).send('Set BLUEBEAM_CLIENT_ID and BLUEBEAM_CLIENT_SECRET before using /auth/login.');
  }
  res.redirect(tokens.authorizeUrl(redirectUri(req), newState()));
});

// Studio redirects back here with ?code=...&state=... — verify state, then
// exchange the code for tokens (incl. the long-lived refresh token).
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  if (!code) {
    const err = req.query.error_description || req.query.error || 'no code returned';
    return res.status(400).send('Authorization failed: ' + err);
  }
  if (!state || !consumeState(String(state))) {
    return res.status(400).send('Authorization failed: state missing, expired, or not recognized. Start again at /auth/login (the server may have restarted between login and callback).');
  }
  try {
    await tokens.exchangeCode(String(code), redirectUri(req));
    const s = tokens.status();
    res.set('Content-Type', 'text/html').send(
      '<!doctype html><meta charset=utf-8><title>Connected</title>' +
      '<body style="font:15px system-ui;max-width:640px;margin:60px auto;color:#12202E">' +
      '<h2 style="color:#1F8A54">Connected to Bluebeam Studio</h2>' +
      '<p>The server now holds a refresh token and will keep access tokens fresh automatically.</p>' +
      '<p style="color:#5E6C7A">Mode: <code>' + s.mode + '</code> · access token valid ~' + (s.expiresInSeconds || '?') + 's.</p>' +
      '<p><a href="/">Open the viewer &rarr;</a></p></body>'
    );
  } catch (e) {
    res.status(502).send('Token exchange failed: ' + e.message + (e.detail ? ' — ' + JSON.stringify(e.detail) : ''));
  }
});

app.get('/api/sessions/:sid', async (req, res) => {
  const sid = req.params.sid;
  const [sess, files] = await Promise.all([
    bb('/publicapi/v1/sessions/' + encodeURIComponent(sid)),
    bb('/publicapi/v1/sessions/' + encodeURIComponent(sid) + '/files'),
  ]);
  if (!sess.ok) return fail(res, sess, 'GET session');
  res.json({ session: sess.json, files: filesArray(files.json) });
});

app.get('/api/sessions/:sid/files/:fid/markups', async (req, res) => {
  const m = await getMergedMarkups(req.params.sid, req.params.fid);
  if (!m.ok) return fail(res, m.r, 'GET markups');
  res.json({ markups: m.markups });
});

app.get('/api/sessions/:sid/files/:fid/snapshot', async (req, res) => {
  const snap = await ensureSnapshot(req.params.sid, req.params.fid);
  res.json(snap);
});

// Aggregate call the frontend uses: everything for one Session ID.
app.get('/api/load/:sid', async (req, res) => {
  const sid = req.params.sid;
  const [sess, files] = await Promise.all([
    bb('/publicapi/v1/sessions/' + encodeURIComponent(sid)),
    bb('/publicapi/v1/sessions/' + encodeURIComponent(sid) + '/files'),
  ]);
  if (!sess.ok) return fail(res, sess, 'GET session');

  const fileList = filesArray(files.json);
  const file = pickPdf(fileList);
  if (!file) {
    return res.json({ session: sess.json, files: fileList, file: null, markups: [], snapshot: null });
  }
  const fid = file.Id != null ? file.Id : file.id;

  // Only the markups are needed up front. The real page image comes from the PDF
  // itself, rendered client-side with pdf.js from the proxied DownloadUrl — crisp
  // and per-page, unlike the low-res single SnapshotDownloadUrl thumbnail.
  const mm = await getMergedMarkups(sid, fid);

  res.json({
    session: sess.json,
    files: fileList,
    file: { id: fid, name: file.Name || file.name || '' },
    markups: mm.ok ? mm.markups : [],
    pdfUrl: '/api/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(fid) + '/pdf',
  });
});

// Stream the Session document PDF (via its DownloadUrl) so pdf.js can render it
// same-origin. The DownloadUrl is a short-lived S3 link fetched per request.
app.get('/api/sessions/:sid/files/:fid/pdf', async (req, res) => {
  const r = await bb('/publicapi/v1/sessions/' + encodeURIComponent(req.params.sid) + '/files/' + encodeURIComponent(req.params.fid));
  if (!r.ok) return fail(res, r, 'GET file detail');
  const url = r.json && r.json.DownloadUrl;
  if (!url) return res.status(404).json({ error: 'No DownloadUrl on this Session file.' });
  try {
    const up = await fetch(url);
    if (!up.ok) return res.status(up.status).send('upstream ' + up.status);
    res.set('Content-Type', up.headers.get('content-type') || 'application/pdf');
    res.set('Cache-Control', 'private, max-age=120');
    res.send(Buffer.from(await up.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: 'PDF proxy error: ' + e.message });
  }
});

// Optional image proxy (kept for the snapshot thumbnail if ever needed).
app.get('/api/image', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).send('bad url');
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).send('upstream ' + r.status);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).send('image proxy error');
  }
});

// SPA-ish fallback: send the viewer for any non-API, non-auth GET.
app.get(/^\/(?!api\/|auth\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  const s = tokens.status();
  console.log('BH Markup Viewer on :' + PORT + '  (auth mode: ' + s.mode + ', api ' + API_BASE + ')');
});
