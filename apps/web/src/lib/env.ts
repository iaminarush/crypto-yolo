/**
 * Type-safe environment variables for the web app.
 *
 * Validated once at startup by @t3-oss/env-core — a missing or malformed
 * variable crashes the app with a list of every issue, so misconfigured
 * deploys fail loudly instead of rendering broken cards.
 *
 * - `server` vars come from `process.env` and are never bundled to the
 *   browser (accessing one on the client throws).
 * - `client` vars must carry the Vite `VITE_` prefix (enforced at type level
 *   and runtime) and are inlined into the client bundle at build time.
 * - `EXTENDED_API` / `RISEX_WALLET` are optional because they have code-level
 *   fallbacks (a default endpoint, and HYPERLIQUID_WALLET respectively).
 *
 * When better-auth is wired up, add its secrets here (BETTER_AUTH_SECRET,
 * BETTER_AUTH_URL, ...) as required server vars.
 */
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    HYPERLIQUID_WALLET: z.string().min(1),
    EXTENDED_API_KEY: z.string().min(1),
    // Optional override; defaults to https://api.starknet.extended.exchange
    EXTENDED_API: z.url().optional(),
    // Optional; falls back to HYPERLIQUID_WALLET
    RISEX_WALLET: z.string().min(1).optional(),
  },
  clientPrefix: "VITE_",
  client: {
    VITE_SUPABASE_URL: z.url(),
    VITE_SUPABASE_KEY: z.string().min(1),
  },
  runtimeEnv: {
    // Server context reads process.env; Vite (dev + build) provides
    // import.meta.env with the VITE_* vars inlined on both sides.
    ...process.env,
    ...import.meta.env,
  },
  // Treat `VAR=` in .env files as unset instead of a validation failure.
  emptyStringAsUndefined: true,
});
