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

## Checks after a deploy
- `/api/health`, `/api/live-positions` and `/api/sanctions/status` answer 200.
- The map loads and vessels appear within a couple of minutes.

See `docs/SECURITY.md` for the security posture and `docs/COST_NOTES.md` for costs.
