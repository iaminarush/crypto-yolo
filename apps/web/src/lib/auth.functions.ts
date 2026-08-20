/**
 * Server-side auth helpers for server functions and route guards.
 *
 * The request middleware captures the incoming Request (session cookie
 * included) and threads it into the handler context.
 */
import { createMiddleware, createServerFn } from "@tanstack/react-start";

import { auth } from "~/lib/auth";

const withHeaders = createMiddleware().server(async ({ request, next }) => {
	return next({ context: { headers: request.headers } });
});

/** Middleware that rejects unauthenticated requests. */
export const requireAuth = createMiddleware().server(
	async ({ request, next }) => {
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) {
			throw new Error("Unauthorized");
		}
		return next();
	},
);

/** Returns the session for the current request, or null when signed out. */
export const getSession = createServerFn({ method: "GET" })
	.middleware([withHeaders])
	.handler(async ({ context }) => {
		return auth.api.getSession({ headers: context.headers });
	});
