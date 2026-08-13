/**
 * SERVER-ONLY: better-auth instance.
 *
 * Imported exclusively from server code (the /api/auth route handlers and
 * server functions) so the database pool and secret never reach the browser.
 *
 * The `tanstackStartCookies` plugin makes better-auth's Set-Cookie responses
 * flow through TanStack Start's cookie handling (required for SSR sessions).
 * It must stay the LAST plugin in the array.
 *
 * Tables are created/migrated with the better-auth CLI:
 *   cd apps/web && DATABASE_URL=<session pooler url> npx auth@latest migrate
 */
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Pool } from "pg";

import { env } from "./env";

export const auth = betterAuth({
  database: new Pool({
    connectionString: env.DATABASE_URL,
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      // Existing GitHub-linked users can still sign in; new users can't sign up via GitHub.
      disableSignUp: true,
    },
  },
  plugins: [tanstackStartCookies()],
});
