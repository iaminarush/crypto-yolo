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
 * BETTER_AUTH_SECRET / BETTER_AUTH_URL / DATABASE_URL feed better-auth
 * (see ~/lib/auth). DATABASE_URL must be a Postgres connection string —
 * for the Supabase project use the Session pooler URL from
 * Dashboard → Connect (port 5432; prepared statements need session mode).
 */
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		WALLET_ADDRESS: z.string().min(1),
		EXTENDED_API_KEY: z.string().min(1),
		// Better-auth secret (32+ chars) — e.g. `openssl rand -base64 32`
		BETTER_AUTH_SECRET: z.string().min(32),
		// Public base URL of the app, e.g. http://localhost:3000 in dev
		BETTER_AUTH_URL: z.url(),
		// Supabase Session pooler connection string (see .env.example)
		DATABASE_URL: z.url(),
		SUPABASE_KEY: z.string().min(1),
		RW_KEY: z.string().min(1),
		// GitHub OAuth app credentials (see .env.example)
		GITHUB_CLIENT_ID: z.string().min(1),
		GITHUB_CLIENT_SECRET: z.string().min(1),
	},
	clientPrefix: "VITE_",
	client: {},
	runtimeEnv: {
		// Server context reads process.env; Vite (dev + build) provides
		// import.meta.env with the VITE_* vars inlined on both sides.
		...process.env,
		...import.meta.env,
	},
	// Treat `VAR=` in .env files as unset instead of a validation failure.
	emptyStringAsUndefined: true,
});
