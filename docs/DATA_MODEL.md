# SvalMap Data Model

## Overview
SvalMap has no database. The API in `scripts-runner` keeps live state in memory and reads and writes plain files under `data/`. Paths are portable through `SVALMAP_ROOT` / `DATA_DIR` (see `scripts-runner/paths.ts`).

## In memory
- **Vessel cache**: latest AISStream and BarentsWatch positions, merged per MMSI, with a stale sweep after about 45 minutes.
- **24h tracks**: recent positions per vessel, served by `/api/tracks24h`.
- **Watch sets**: sanctioned, shadow-fleet and military MMSIs / IMOs, loaded from the files below.
- **Upstream caches**: short-lived copies of GFW events and Kystverket nav warnings.

Restarting the API clears this state, apart from what the snapshot below restores.

## Files
| Path | Contents |
|------|----------|
| `data/source/overlays/` | Static GeoJSON overlays (cables, petroleum, ports and so on) |
| `data/source/fisheriesprotectionzone.geojson` | Svalbard FPZ boundary, used in the display filter |
| `data/source/Proximity markers/AOI/` | Norway and Jan Mayen zone polygons |
| `data/source/Sanctionlist.CSV`, `Sanction list EU.CSV`, `eu-designated-vessels.csv`, `opensanctions-vessels.csv` | Sanctions lists, refreshed by the weekly updater |
| `data/source/shadowfleet2.csv` | Shadow-fleet vessels |
| `data/source/Norwegian-military-vessel-mmsi.txt` | Norwegian military MMSIs |
| `data/cache/aisstream-snapshot.json` | Vessel cache snapshot, reloaded on startup |
| `data/cache/` | Other generated caches, safe to delete |

## API shapes
Shared TypeScript interfaces are in `packages/types`. The response of each endpoint is defined in `scripts-runner/server.ts`.
