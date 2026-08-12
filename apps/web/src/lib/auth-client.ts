/**
 * Better-auth client used from the browser.
 *
 * baseURL defaults to "/api/auth" on the same origin, which matches the
 * mounted handler at /api/auth/$ (see src/routes/api/auth/$.ts). Cookies are
 * set/read by the server through the tanstackStartCookies plugin.
 */
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient();
