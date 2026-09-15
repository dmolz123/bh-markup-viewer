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
    return { ok: false, status: 401, json: { error: 'Could not obtain a Studio token: ' + e.message, detail: e.detail } };
  }
  if (!token) {
    return { ok: false, status: 500, json: { error: 'No Studio credentials configured. Set BLUEBEAM_CLIENT_ID/BLUEBEAM_CLIENT_SECRET + a refresh token (or connect via /auth/login), or set BLUEBEAM_TOKEN.' } };
  }
  const res = await fetch(API_BASE + pathPart, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && !_retried && tokens.haveOAuth()) {
    try { await tokens.getAccessToken(true); } catch { /* fall through to report 401 */ }
    return bb(pathPart, opts, true);
  }
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { ok: res.ok, status: res.status, json };
}

// Bubble a Studio failure to the client with a useful message (esp. 401 = token expired).
function fail(res, r, where) {
  const hint = r.status === 401
    ? 'Studio returned 401 — the Bearer token is missing, invalid, or expired. Refresh BLUEBEAM_TOKEN in the environment.'
    : ('Studio API error at ' + where + '.');
  res.status(r.status && r.status >= 400 ? r.status : 502).json({ error: hint, status: r.status, detail: r.json });
}

// ---- merge markups (list) + details (rect) by markupId ---------------------
function mergeMarkups(list, details) {
  const byId = new Map();
  (Array.isArray(list) ? list : []).forEach((m) => {
    byId.set(String(m.markupId), {
      markupId: m.markupId,
      pageNumber: m.pageNumber,
      subject: m.subject || '',
      status: m.status || '',
      type: m.type || '',
      author: m.displayName || m.email || '',
      x: m.x, y: m.y,
      documentWidth: m.documentWidth,
      documentHeight: m.documentHeight,
      contents: m.comments || '',
      rect: null,
    });
  });
  (Array.isArray(details) ? details : []).forEach((d) => {
    const key = String(d.markupId);
    const cur = byId.get(key) || { markupId: d.markupId };
    byId.set(key, {
      ...cur,
      pageNumber: cur.pageNumber != null ? cur.pageNumber : d.pageNumber,
      subject: cur.subject || d.subject || '',
      status: cur.status || d.status || '',
      type: cur.type || d.type || '',
      author: cur.author || d.author || '',
      contents: d.contents || cur.contents || '',
      rect: Array.isArray(d.rect) && d.rect.length === 4 ? d.rect : cur.rect || null,
      width: d.width,
    });
  });
  // only markups we can place (have a rect) come first; keep the rest too for the list
  return Array.from(byId.values()).sort((a, b) => {
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

function pickPdf(files) {
  const arr = Array.isArray(files) ? files : (files && files.ProjectFiles) || [];
  const list = Array.isArray(files) ? files : arr;
  const pdfs = list.filter((f) => /\.pdf$/i.test(f.Name || f.name || ''));
  return (pdfs[0] || list[0] || null);
}

// ---- routes ----------------------------------------------------------------
app.get('/api/health', (req, res) => {
  const auth = tokens.status();
  res.json({ ok: true, apiBase: API_BASE, auth, ready: auth.ready, tokenPresent: auth.ready });
});

// One-time authorization: send the admin to Studio to grant access.
app.get('/auth/login', (req, res) => {
  if (!tokens.config.CLIENT_ID || !tokens.config.CLIENT_SECRET) {
    return res.status(400).send('Set BLUEBEAM_CLIENT_ID and BLUEBEAM_CLIENT_SECRET before using /auth/login.');
  }
  res.redirect(tokens.authorizeUrl(redirectUri(req)));
});

// Studio redirects back here with ?code=... — exchange it for tokens (incl. the
// long-lived refresh token, which is then cached + persisted).
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    const err = req.query.error_description || req.query.error || 'no code returned';
    return res.status(400).send('Authorization failed: ' + err);
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
  res.json({ session: sess.json, files: files.ok ? files.json : [] });
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

  const fileList = Array.isArray(files.json) ? files.json : [];
  const file = pickPdf(fileList);
  if (!file) {
    return res.json({ session: sess.json, files: fileList, file: null, markups: [], snapshot: null });
  }
  const fid = file.Id != null ? file.Id : file.id;

  const [mm, snap] = await Promise.all([
    getMergedMarkups(sid, fid),
    ensureSnapshot(sid, fid).catch(() => ({ status: 'Error', downloadUrl: null })),
  ]);

  res.json({
    session: sess.json,
    files: fileList,
    file: { id: fid, name: file.Name || file.name || '' },
    markups: mm.ok ? mm.markups : [],
    snapshot: snap,
  });
});

// Optional image proxy (only needed if the snapshot DownloadUrl isn't publicly fetchable).
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
