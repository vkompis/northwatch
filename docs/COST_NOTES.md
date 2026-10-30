# SvalMap Cost Notes

## Overview
SvalMap is kept cheap on purpose: one always-on Express API, one Next.js app, and no database. There is no BigQuery, Firestore or other paid storage. Positions live in memory, and everything else is plain files under `data/`.

## What costs money
- **Hosting**: one small always-on process for `scripts-runner` (it keeps the AISStream WebSocket open) and one for `apps/web`.
- **Email alerts** (optional): whatever the SMTP provider charges. Alerts work without email.

## What should stay free
- **Data sources**: AISStream, BarentsWatch, Global Fishing Watch, Copernicus / OSI SAF, Kystverket and the public sanctions lists. Check each provider's terms if usage grows.
- **Base map**: the default style uses free tiles. MapTiler is only needed if `NEXT_PUBLIC_MAPTILER_KEY` is set.

## Keeping it that way
- Do not add a storage service for position history. Historic tracks come from BarentsWatch on demand.
- Keep caching in memory or in files under `data/cache/`.
- Keep upstream polling on the existing cadences (see `docs/ARCHITECTURE.md`) so free quotas last.
