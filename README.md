# SvalMap - Maritime Monitoring System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![MapLibre](https://img.shields.io/badge/MapLibre-3.6-green.svg)](https://maplibre.org/)

A maritime monitoring map focused on the Svalbard Fisheries Protection Zone and the wider North Atlantic north of 54°N. Live AIS (AISStream + BarentsWatch), sanctions / shadow-fleet flags, ice edge, GFW events, and navigation warnings.

## Features (live map)

- **Live vessel tracking**: AISStream WebSocket + BarentsWatch merge, polled by the UI every ~20s
- **Display rules**: Broad traffic in the Svalbard FPZ; elsewhere RU / research / sanctions / shadow / military
- **Interactive MapLibre map**: Category markers, heading triangles, fading labels, historic tracks (1–14 days via free BarentsWatch)
- **Research tools**: vessel search, ship filters, watchlists + notes, citeable export packs, shareable `?mmsi=` deep links
- **Overlays**: EEZ / FPZ, ice edge (Copernicus), cables, petroleum, NSM, firing ranges, ports, nav warnings (active / last 30 days)
- **GFW events**: Loitering, encounters, AIS-off, port visits (RU / sanctioned / shadow filtered)
- **Area alerts**: Client polling + file-backed server watcher (email if `SMTP_*` configured; free without email)
- **Live heuristics**: Proximity / loiter among vessels of interest

## Architecture (what actually runs)

```
apps/web          → Next.js map (default API http://localhost:8787)
scripts-runner    → Production live API (AIS, tracks, GFW proxy, sanctions, ice edge, overlays)
packages/ui       → MapLibre React layers shared by the web app
```

**Local map stack:** start `scripts-runner` on port **8787**, then `apps/web` on **3000**. Set `NEXT_PUBLIC_API_BASE_URL=http://localhost:8787`.

Optional: `API_KEY` (require `X-API-Key`), `TLS_INSECURE=1` (only if TLS verification must be disabled), `SVALMAP_ROOT` / `DATA_DIR` for portable data paths.

## Repository layout

```
svalmap/
├── apps/
│   └── web/          # Next.js frontend with MapLibre integration
├── scripts-runner/   # Live AIS + overlays API used by the web map
├── packages/
│   ├── types/        # Shared TypeScript interfaces
│   ├── ui/           # Reusable React / MapLibre components
│   └── config/       # Shared configuration
├── data/source/      # GeoJSON overlays, sanctions CSVs, markers
└── docs/             # Architecture, security, deploy notes
```

## Quick Start

### Prerequisites

- Node.js 18+ and npm 9+
- AISStream / BarentsWatch / optional GFW + Copernicus credentials (see `.env`)

### Installation

1. **Clone and install**
   ```bash
   git clone https://github.com/your-org/svalmap.git
   cd svalmap
   npm install
   ```

2. **Environment**
   ```bash
   cp apps/web/.env.example apps/web/.env.local
   # Configure AISSTREAM_API_KEY, BarentsWatch OAuth, GFW_API_TOKEN, etc. for scripts-runner
   ```

3. **Start the live stack**
   ```bash
   # Terminal 1 — live API
   cd scripts-runner && npx tsx server.ts

   # Terminal 2 — web map
   npm run dev --workspace=@svalmap/web
   ```

4. **Access**
   - **Web App**: http://localhost:3000
   - **Live API**: http://localhost:8787 (`/api/health`, `/api/live-positions`)

## Geographic Coverage

- **Primary**: Svalbard Fisheries Protection Zone — most AIS traffic (with length filters for small fishing / recreational)
- **Extended**: North Atlantic ≥54°N — Russian, research, sanctioned, shadow fleet, and military / LE vessels
- **Context layers**: EEZ boundaries, undersea cables, petroleum, NSM areas, ice edge, Kystverket nav warnings

## Technology Stack

### Frontend
- **Next.js 14**: React framework with App Router
- **TypeScript**: Type-safe development
- **MapLibre GL JS**: Open-source mapping library
- **Tailwind CSS**: Utility classes (map chrome is mostly custom CSS)

### Live backend (`scripts-runner`)
- **Express** + in-memory AIS / sanctions caches
- **AISStream** WebSocket + **BarentsWatch** live / historic AIS
- **GFW** v3 gateway proxy
- **Copernicus / OSI SAF** ice edge (Python toolbox)

### Infrastructure
- No database: in-memory state plus files under `data/`
- Local static GeoJSON under `data/source/`

### Development Tools
- **Turbo**: Monorepo build system
- **ESLint**: Code linting
- **Prettier**: Code formatting
- **Vitest**: Unit testing
- **Playwright**: E2E testing

## Data Sources

- **AIS Data**: Real-time vessel positions from Norwegian Coastal Administration
- **Military Vessel MMSI**: Norwegian Armed Forces vessel identifiers
- **Restricted Areas**: NSM military restricted zones
- **Cable Routes**: Svalbard submarine cable infrastructure
- **Sanctions**: Norwegian and EU sanctions lists

## Security Features

- **Incident Detection**: Proximity alerts, rendezvous detection, loitering identification
- **Sanctions Monitoring**: Vessel blacklist checking and alerting
- **Shadow Tracking**: Monitoring vessels that turn off AIS
- **Research Vessel Monitoring**: Special attention to research activities
- **Role-based Access Control**: Multi-level user permissions
- **Audit Logging**: Comprehensive security event tracking

## Monitoring & Analytics

- **Real-time Updates**: 5-minute cadence for vessel positions
- **Incident Analytics**: Historical incident analysis and trends
- **Performance Metrics**: System performance and usage statistics
- **Cost Monitoring**: Cloud resource usage and cost optimization

## Deployment

SvalMap runs as two Node processes, the API and the web app. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Testing

### Run Tests

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Type checking
npm run type-check

# Linting
npm run lint
```

### Test Coverage

- **Unit Tests**: Vitest with >90% coverage target
- **Integration Tests**: API endpoint testing
- **E2E Tests**: Playwright browser automation
- **Performance Tests**: Load testing and benchmarking

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)**: System design and architecture overview
- **[Data Model](docs/DATA_MODEL.md)**: Where live state and data files are kept
- **[Security](docs/SECURITY.md)**: Security measures and best practices
- **[Deployment](docs/DEPLOY.md)**: Deployment procedures and infrastructure setup
- **[Style Guide](docs/STYLEGUIDE.md)**: Code standards and development practices
- **[Cost Notes](docs/COST_NOTES.md)**: Cost structure and optimization strategies
- **[Attribution](docs/ATTRIBUTION.md)**: Data sources and third-party attributions

## Contributing

### Development Workflow

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```
3. **Make your changes**
4. **Run tests and linting**
   ```bash
   npm run test
   npm run lint
   npm run type-check
   ```
5. **Commit your changes**
   ```bash
   git commit -m 'feat: add amazing feature'
   ```
6. **Push to your branch**
   ```bash
   git push origin feature/amazing-feature
   ```
7. **Create a Pull Request**

### Code Standards

- Follow the [Style Guide](docs/STYLEGUIDE.md)
- Use TypeScript for all new code
- Write comprehensive tests
- Update documentation as needed
- Follow conventional commit messages

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Norwegian Coastal Administration** for AIS data
- **Norwegian Armed Forces** for military vessel information
- **OpenStreetMap contributors** for base map data
- **MapLibre contributors** for open-source mapping library

