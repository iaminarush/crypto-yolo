# Robot Wealth YOLO factors Crypto Trading

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

- `src/trade-extended.ts`: Lambda handler for X10 (Extended) trading logic.
- `src/trade-hyperliquid.ts`: Lambda handler for Hyperliquid trading logic.
- `src/timestamp-checker.ts`: Utility function to monitor and trigger workers.
- `src/notifier.ts`: Telegram notification handler for system alerts.
- `src/extended/`: Core logic, API wrappers, and utilities for the X10 exchange.
- `src/hyperliquid/`: Logic and helpers for the Hyperliquid exchange.
- `bruno/`: API collection for testing endpoints via [Bruno](https://www.usebruno.com/).

## Database

The project uses Supabase for data persistence. To regenerate TypeScript types from your Supabase schema:

```bash
pnpm genDBTypes
```
