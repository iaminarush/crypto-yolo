import { createFileRoute } from "@tanstack/react-router";

import { getExtendedData, getHlData, getRisexData } from "./-positions-server";

export const Route = createFileRoute("/_authenticated/")({
	component: Home,
	pendingComponent: HomePending,
	pendingMs: 150,
	pendingMinMs: 300,
	loader: async () => {
		const [extended, hyperliquid, risex] = await Promise.all([
			getExtendedData(),
			getHlData(),
			getRisexData(),
		]);
		return { extended, hyperliquid, risex };
	},
});

type OutOfBoundsPosition = Awaited<ReturnType<typeof getHlData>>[number];

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

function OutOfBoundsCard({
	exchange,
	positions,
}: {
	exchange: string;
	positions: OutOfBoundsPosition[];
}) {
	return (
		<div className="card">
			<h2>
				{exchange}
				<span className={positions.length > 0 ? "badge err" : "badge ok"}>
					{positions.length > 0
						? `${positions.length} out of bounds`
						: "In bounds"}
				</span>
			</h2>
			{positions.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Market</th>
							<th>Gap to target</th>
						</tr>
					</thead>
					<tbody>
						{positions.map((p) => (
							<tr key={p.ticker}>
								<td>{p.ticker}</td>
								<td className="short">{usd.format(p.priceGap)}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<p className="empty">All positions within bounds</p>
			)}
		</div>
	);
}

function LoadingCard({ exchange }: { exchange: string }) {
	return (
		<div className="card">
			<h2>{exchange}</h2>
			<p className="empty">
				<span className="spinner" aria-hidden="true" />
				Loading positions…
			</p>
		</div>
	);
}

function HomePending() {
	return (
		<div className="grid">
			<LoadingCard exchange="Extended" />
			<LoadingCard exchange="Hyperliquid" />
			<LoadingCard exchange="Risex" />
		</div>
	);
}

function Home() {
	const { extended, hyperliquid, risex } = Route.useLoaderData();
	return (
		<div className="grid">
			<OutOfBoundsCard exchange="Extended" positions={extended} />
			<OutOfBoundsCard exchange="Hyperliquid" positions={hyperliquid} />
			<OutOfBoundsCard exchange="Risex" positions={risex} />
		</div>
	);
}
