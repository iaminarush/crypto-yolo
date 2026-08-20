import { createFileRoute, redirect } from "@tanstack/react-router";

import { getSession } from "~/lib/auth.functions";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/login")({
	beforeLoad: async () => {
		// Already signed in → straight to the app.
		const session = await getSession();
		if (session) {
			throw redirect({ to: "/" });
		}
	},
	component: Login,
});

function Login() {
	const handleGithub = () => {
		authClient.signIn.social({ provider: "github" });
	};

	return (
		<div className="login">
			<div className="login-card">
				<button type="button" className="login-button" onClick={handleGithub}>
					Sign in with GitHub
				</button>
			</div>
		</div>
	);
}
