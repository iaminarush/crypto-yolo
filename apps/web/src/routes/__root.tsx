/// <reference types="vite/client" />
import {
	HeadContent,
	Link,
	Scripts,
	createRootRoute,
} from "@tanstack/react-router";
import type * as React from "react";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Robot Wealth | Positions",
			},
			{
				name: "description",
				content:
					"Live positions dashboard for the Robot Wealth YOLO trading system",
			},
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<nav className="nav">
					<div className="nav-brand">Robot Wealth YOLO</div>
					<Link
						to="/"
						activeProps={{ className: "nav-link active" }}
						activeOptions={{ exact: true }}
						className="nav-link"
					>
						Positions
					</Link>
				</nav>
				<main className="main">{children}</main>
				<Scripts />
			</body>
		</html>
	);
}
