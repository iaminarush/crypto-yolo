/**
 * Authenticated layout. Every route nested under this (pathless) route is
 * protected: `beforeLoad` checks the session and redirects to /login when the
 * request is unauthenticated. It re-renders on the client after hydration so
 * soft navigations are guarded too.
 */
import {
	createFileRoute,
	Outlet,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { getSession } from "~/lib/auth.functions";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	component: AuthLayout,
});

function AuthLayout() {
	const navigate = useNavigate();
	const handleSignOut = async () => {
		await authClient.signOut().catch(() => {});
		// Navigating runs beforeLoad, whose guard redirects to /login.
		navigate({ to: "/" });
	};

	return (
		<>
			<nav className="nav">
				<div className="nav-brand">Crypto YOLO</div>
				<button type="button" className="nav-signout" onClick={handleSignOut}>
					Sign out
				</button>
			</nav>
			<main className="main">
				<Outlet />
			</main>
		</>
	);
}
