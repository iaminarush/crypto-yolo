/**
 * Mounts better-auth at /api/auth/*. The `$` splat catches every sub-path
 * (sign-in/email, get-session, sign-out, ...) and forwards the raw Request to
 * auth.handler, which routes it to the right endpoint.
 *
 * The server.handlers block runs exclusively on the server; the client bundle
 * gets a stub, so ~/lib/auth (database pool, secret) never ships to the
 * browser.
 */
import { createFileRoute } from "@tanstack/react-router";

import { auth } from "~/lib/auth";

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: async ({ request }: { request: Request }) => auth.handler(request),
			POST: async ({ request }: { request: Request }) => auth.handler(request),
		},
	},
});
