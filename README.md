# BH Markup Viewer

A small web app that shows the **markups on a Bluebeam Studio Session document**,
overlaid on the page by their real geometry, deep-linkable to any single markup,
with a one-click **Open in Revu**.

Type a **Session ID**, press **Enter**, and the app renders that Session's markups
over the document snapshot. Each markup is clickable and gets a shareable URL that
jumps straight back to it.

> Reference implementation for a customer conversation. Provided as-is, not a
> supported Bluebeam product.

## Why there's a backend

A static HTML page can't call the Studio API directly:

- **OAuth** — the API needs a `Bearer` token that shouldn't live in the browser.
- **CORS** — `api.bluebeam.com` won't allow browser-origin calls from an arbitrary page.

So a tiny Node/Express server holds the token in an environment variable and
exposes a few same-origin `/api/*` routes. The browser only ever talks to this
server.

## What it maps to (Studio public API)

All field names are taken verbatim from the Studio OpenAPI spec.

| In the app | Studio API |
|---|---|
| Session + file | `GET /publicapi/v1/sessions/{id}` , `GET /publicapi/v1/sessions/{id}/files` |
| Markup list (status, page, x/y, documentWidth/Height) | `GET /publicapi/v2/sessions/{sid}/files/{fileId}/markups` |
| Markup geometry (`rect`, contents) | `GET /publicapi/v2/sessions/{sid}/files/{fileId}/markups/details` |
| Page image | `POST` then `GET /publicapi/v1/sessions/{sid}/files/{id}/snapshot` → `DownloadUrl` |
| Open in Revu | `studio://studio.bluebeam.com/sessions/{sid}` |
| Shareable markup link | app URL `#session/{sid}/markup/{markupId}` |

The overlay converts each markup's `rect` (`[x1,y1,x2,y2]` in PDF points, bottom-left
origin) into image space using the page's `documentWidth`/`documentHeight` (Y-flip).

## Authentication

Studio uses the OAuth2 **authorization-code flow** with the `offline_access`
scope — there is no client-credentials grant, but `offline_access` returns a
**long-lived refresh token**. The server supports two modes:

| Mode | Env vars | Behavior |
|---|---|---|
| **OAuth auto-refresh** (recommended) | `BLUEBEAM_CLIENT_ID`, `BLUEBEAM_CLIENT_SECRET`, and a refresh token | Server trades the refresh token for access tokens automatically, refreshing before expiry and again on any `401`. Hands-off. |
| **Static token** (fallback) | `BLUEBEAM_TOKEN` | You paste a short-lived access token. Expires; you re-paste it. |

Getting the refresh token for OAuth mode — either:
- **Self-service:** set the client id/secret, deploy, then visit
  `https://<your-app>/auth/login` once. Studio prompts you to grant access and
  redirects back to `/auth/callback`; the server captures the refresh token and
  keeps it. (Your OAuth client must allow `<your-app>/auth/callback` as a
  redirect URI — set `APP_BASE_URL` if it must match exactly.)
- **Paste one:** put a refresh token you already have in `BLUEBEAM_REFRESH_TOKEN`.

## Run locally

```bash
npm install
cp .env.example .env      # fill in OAuth vars (or BLUEBEAM_TOKEN)
npm start                 # http://localhost:3000
```

## Deploy on Render

1. Push this repo to GitHub (already wired).
2. In Render: **New → Web Service**, pick this repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. In the service's **Environment** tab, add either:
   - **OAuth mode:** `BLUEBEAM_CLIENT_ID`, `BLUEBEAM_CLIENT_SECRET` (and
     optionally `BLUEBEAM_REFRESH_TOKEN` and `APP_BASE_URL`), **or**
   - **Static mode:** `BLUEBEAM_TOKEN`.
4. Deploy. If using OAuth self-service, visit `/auth/login` once. Then open the
   URL, enter a Session ID, press Enter.

(There's also a `render.yaml` blueprint if you prefer Infrastructure-as-Code.)

## Notes / limits

- **Token expiry** — in OAuth mode the server refreshes access tokens
  automatically (before expiry and on `401`), so no hand-pasting. In static-token
  mode, when calls start returning `401` the app shows a clear banner and you
  refresh `BLUEBEAM_TOKEN`.
- **Refresh-token rotation** — if Studio returns a new refresh token on refresh,
  the server keeps it in memory and best-effort persists it to `TOKEN_STORE_PATH`
  (defaults to the OS temp dir). On Render's free tier the filesystem is
  ephemeral across redeploys; if your client hard-rotates refresh tokens,
  re-run `/auth/login` after a redeploy or attach a persistent disk.
- **Snapshot page** — the snapshot endpoint renders the document as a single
  image (treated here as page 1). Markups on other pages are shown at their true
  positions on a plain sheet; wire per-page rendering when you have a page-image
  source for every page.
- **Read-only** — the server only reads markups and asks Studio to render a
  snapshot image. It does not modify the Session.
- The token is read from the environment and never sent to the browser.

## Endpoints (server)

| Route | Purpose |
|---|---|
| `GET /api/health` | reports auth mode and readiness |
| `GET /auth/login` | one-time: redirect to Studio to authorize (OAuth mode) |
| `GET /auth/callback` | OAuth redirect target; exchanges the code, stores the refresh token |
| `GET /api/load/:sid` | aggregate: session + first PDF + merged markups + snapshot URL |
| `GET /api/sessions/:sid` | session detail + files |
| `GET /api/sessions/:sid/files/:fid/markups` | merged markup list + details |
| `GET /api/sessions/:sid/files/:fid/snapshot` | ensure + return snapshot `DownloadUrl` |
| `GET /api/image?url=` | optional image proxy (snapshot fallback) |

## License

MIT. See [LICENSE](LICENSE).
