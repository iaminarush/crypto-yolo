# Robot Wealth YOLO factors Crypto Trading

Monorepo (pnpm workspaces) containing the SST-deployed trading workers at the
root and a separately-hosted positions dashboard in `apps/web`.

## Prerequisites

- **Node.js**: v20 or later (Project uses `nodejs24.x` runtime)
- **pnpm**: v10.32.1 or later
- **AWS CLI**: Configured with an `admin` profile (or update `sst.config.ts`)
- **SST**: Installed globally or used via `pnpm sst`

## Getting Started

### 1. Configure AWS Profile

The `sst.config.ts` expects an AWS profile named `admin`. If your profile has a different name, update the `profile` field in `sst.config.ts`:

```typescript
// sst.config.ts
providers: {
  aws: {
    profile: "your-profile-name",
  },
},
```

### 2. Set Up Secrets

You must configure the following secrets using the SST CLI before running the application:

```bash
# General
pnpm sst secret set ROBOTWEALTH_KEY <value>
pnpm sst secret set SUPABASE_KEY <value>

# X10 (Extended) Exchange
pnpm sst secret set EXTENDED_API_KEY <value>
pnpm sst secret set EXTENDED_STARKEX_KEY <value>
pnpm sst secret set EXTENDED_LAMBDA_KEY <value>

# Hyperliquid Exchange
pnpm sst secret set HYPERLIQUID_WALLET <address>
pnpm sst secret set HYPERLIQUID_KEY <private_key>

# Notifications
pnpm sst secret set TELEGRAM_TOKEN <bot_token>
pnpm sst secret set TELEGRAM_ID <chat_id>
```

### 3. Development

Start the SST development console to run your functions locally and live-lambda debug:

```bash
pnpm sst dev
```

## Deployment

To deploy the application to your AWS account:

```bash
# Deploy to dev stage
pnpm sst deploy --stage dev

# Deploy to production
pnpm sst deploy --stage production
```

## Project Structure

```text
├── sst.config.ts          # SST app — Lambda trading workers (deployed to AWS)
├── src/                   # Trading logic for the three exchanges
│   ├── trade-extended.ts  # Lambda handler for X10 (Extended) trading logic
│   ├── trade-hyperliquid.ts # Lambda handler for Hyperliquid trading logic
│   ├── trade-risex.ts     # Lambda handler for RiseX trading logic
│   ├── timestamp-checker.ts # Cron-triggered watcher that kicks off the workers
│   ├── notifier.ts        # Telegram notification handler for system alerts
│   ├── extended/          # Core logic, API wrappers, and utilities for X10
│   ├── hyperliquid/       # Logic and helpers for the Hyperliquid exchange
│   └── api.ts             # Robot Wealth signals + Supabase access
├── apps/web/              # Positions dashboard — TanStack Start, NOT deployed via SST
│   ├── src/routes/        # File-based routes (dashboard lives at /)
│   ├── src/server/        # Server functions — the only boundary to exchange keys
│   ├── src/lib/server/    # Server-only exchange read clients (never in the browser)
│   └── src/lib/supabase.ts # Client-safe Supabase client (anon key + RLS)
├── bruno/                 # API collection for testing endpoints via Bruno
└── database.types.ts      # Generated Supabase types (shared, incl. type-only import from apps/web)
```

The two deployables are independent: `pnpm sst deploy` ships the trading
workers; `apps/web` has its own build pipeline and can be hosted anywhere
(Vercel, a Node box, etc.) via `node .output/server/index.mjs`.

### Positions dashboard (`apps/web`)

```bash
# Install (once, from repo root — installs everything for both apps)
pnpm install

# Dev server on http://localhost:3000
pnpm dev:web

# Production build + typecheck
pnpm build:web

# Run the built server
pnpm start:web
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in:

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — client-safe Supabase access
  (the anon key is public; make sure RLS restricts the `exchange`/`ticker`
  tables to what you're happy exposing).
- `HYPERLIQUID_WALLET` — public wallet address; positions are read from
  Hyperliquid's public Info API (no private key needed).
- `EXTENDED_API_KEY` — X10 read-only REST auth (`x-api-key` header).
- `RISEX_WALLET` — RiseX account address; falls back to `HYPERLIQUID_WALLET`.

Server functions in `src/server/` are the only code that touches these keys;
they run on the server and are stubbed out in client bundles. Missing env vars
degrade the matching card to an "unconfigured" state instead of crashing.

> **Auth note**: the dashboard currently has no authentication. Before
> deploying publicly, add a login (e.g. Supabase Auth) or a shared-secret
> gate so positions aren't world-readable.

## Database

The project uses Supabase for data persistence. To regenerate TypeScript types
from your Supabase schema:

```bash
pnpm genDBTypes
```

`apps/web` imports these types type-only from the repo root — regenerate at the
root and the dashboard stays in sync automatically.

## Workspace notes

- `pnpm-workspace.yaml` declares `apps/*`; the trading app is the root package
  and SST still runs from the repo root.
- `minimumReleaseAge` (7-day supply-chain gate) is fully enforced. `apps/web`
  pins the fast-moving framework packages (`@tanstack/react-start`,
  `@tanstack/react-router`, `vite`) to exact versions from the 2026-08-04
  release batch, which was the latest set published before the 7-day cutoff.
  Bumping them means picking the newest versions whose publish date is at
  least 7 days old — or temporarily adding a `minimumReleaseAgeExclude`
  entry.
- `biome.json` enables git-aware ignores so vendored SST code (`.sst/`) and
  build output (`.output/`) aren't linted.
