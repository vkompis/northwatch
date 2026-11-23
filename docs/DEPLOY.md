# SvalMap Deployment Guide

## Overview
SvalMap runs as two Node processes and needs no database or cloud services:

- **API** (`scripts-runner/server.ts`, port 8787): must be always on, because it holds the AISStream WebSocket and the in-memory vessel cache.
- **Web** (`apps/web`, port 3000): Next.js app that calls the API from the browser.

## Prerequisites
- Node.js 18+ and pnpm
- A writable copy of `data/` next to the API (or point `SVALMAP_ROOT` / `DATA_DIR` at one)
- Python 3 with a `.venv-cmems` virtualenv, only for the Copernicus ice edge

## API

```bash
cd scripts-runner
npm ci
npx tsx server.ts
```

Health check: `GET /api/health`.

| Variable | Purpose |
|----------|---------|
| `AISSTREAM_API_KEY` | AISStream live positions |
| `BW_CLIENT_ID`, `BW_CLIENT_SECRET` | BarentsWatch live and historic AIS |
| `GFW_API_TOKEN` | Global Fishing Watch events and SAR |
| `PORT` | Listen port (default 8787) |
| `CORS_ORIGIN` | Allowed web origin |
| `API_KEY` | Optional: require an `X-API-Key` header |
| `SVALMAP_ROOT`, `DATA_DIR` | Optional: portable data paths |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ALERT_FROM` | Optional: email for area alerts |
| `TLS_INSECURE` | Set to `1` only if TLS verification must be disabled |

## Web

```bash
pnpm install
pnpm --filter @svalmap/web build
pnpm --filter @svalmap/web start
```

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_BASE_URL` | API URL; fixed at build time, so rebuild after changing it |
| `NEXT_PUBLIC_MAP_STYLE`, `NEXT_PUBLIC_MAP_ATTRIBUTION` | Optional: base map style and attribution |
| `NEXT_PUBLIC_MAPTILER_KEY` | Optional: MapTiler-hosted style |

## GitHub Pages snapshot
`.github/workflows/pages.yml` publishes a static copy of the map to GitHub Pages every 30 minutes, on each push to `main`, and when run by hand. Each run starts the API, collects data for about three minutes, saves the responses with `scripts-runner/writeSiteSnapshot.ts`, and builds the web app with `NEXT_PUBLIC_SNAPSHOT=1`. Visitors reload the page for newer data.

Vessel search, tracks, sanctions lookups and area alerts need the live API, so the snapshot hides them.

Setup, once:
- Add the repository secrets `AISSTREAM_API_KEY`, `BW_CLIENT_ID`, `BW_CLIENT_SECRET` and `GFW_API_TOKEN`.
- For the ice edge, also add `COPERNICUSMARINE_SERVICE_USERNAME` and `COPERNICUSMARINE_SERVICE_PASSWORD` (a free Copernicus Marine account). Without them the map shows the ice edge stored in the repository.
- Set Settings → Pages → Source to "GitHub Actions".

A run that collects no vessels fails, so the last good copy stays online.

## Checks after a deploy
- `/api/health`, `/api/live-positions` and `/api/sanctions/status` answer 200.
- The map loads and vessels appear within a couple of minutes.

See `docs/SECURITY.md` for the security posture and `docs/COST_NOTES.md` for costs.
