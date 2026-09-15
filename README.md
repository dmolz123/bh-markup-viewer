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

## Run locally

```bash
npm install
cp .env.example .env      # then paste your Studio token into BLUEBEAM_TOKEN
npm start                 # http://localhost:3000
```

## Deploy on Render

1. Push this repo to GitHub (already wired).
2. In Render: **New → Web Service**, pick this repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. In the service's **Environment** tab, add:
   - `BLUEBEAM_TOKEN` = your Studio access token
   - `BLUEBEAM_API_BASE` = `https://api.bluebeam.com` (optional; this is the default)
4. Deploy, open the URL, enter a Session ID, press Enter.

(There's also a `render.yaml` blueprint if you prefer Infrastructure-as-Code.)

## Notes / limits

- **Token expiry** — Studio access tokens are short-lived. When calls start
  returning `401`, the app shows a clear banner; refresh `BLUEBEAM_TOKEN` and
  redeploy (or restart) the service.
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
| `GET /api/health` | reports whether a token is configured |
| `GET /api/load/:sid` | aggregate: session + first PDF + merged markups + snapshot URL |
| `GET /api/sessions/:sid` | session detail + files |
| `GET /api/sessions/:sid/files/:fid/markups` | merged markup list + details |
| `GET /api/sessions/:sid/files/:fid/snapshot` | ensure + return snapshot `DownloadUrl` |
| `GET /api/image?url=` | optional image proxy (snapshot fallback) |

## License

MIT. See [LICENSE](LICENSE).
