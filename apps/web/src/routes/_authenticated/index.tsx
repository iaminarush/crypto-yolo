import { createFileRoute } from "@tanstack/react-router";

import { getHlData, getRisexData } from "./-positions-server";

export const Route = createFileRoute("/_authenticated/")({
	component: Home,
	pendingComponent: HomePending,
	pendingMs: 150,
	pendingMinMs: 300,
	loader: async () => {
		const [hyperliquid, risex] = await Promise.all([
			getHlData(),
			getRisexData(),
		]);
		return { hyperliquid, risex };
	},
});

type Side = "LONG" | "SHORT";

interface PositionSummary {
	market: string;
	side: Side;
	size: number;
	entryPrice: number;
	markPrice: number;
	unrealizedPnl: number;
}

type OutOfBoundsPosition = Awaited<ReturnType<typeof getHlData>>[number];

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

const price = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 2,
});

const quantity = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 2,
});

function ExchangePositionCard({
	exchange,
	positions,
}: {
	exchange: string;
	positions: PositionSummary[];
}) {
	return (
		<div className="card">
			<h2>
				{exchange}
				<span className={positions.length > 0 ? "badge ok" : "badge"}>
					{positions.length > 0 ? `${positions.length} open` : "No positions"}
				</span>
			</h2>
			{positions.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Market</th>
							<th>Side</th>
							<th>Size</th>
							<th>Entry</th>
							<th>Mark</th>
							<th>Unrealized PnL</th>
						</tr>
					</thead>
					<tbody>
						{positions.map((p) => (
							<tr key={p.market}>
								<td>{p.market}</td>
								<td className={p.side === "LONG" ? "long" : "short"}>
									{p.side}
								</td>
								<td>{quantity.format(p.size)}</td>
								<td>{price.format(p.entryPrice)}</td>
								<td>{price.format(p.markPrice)}</td>
								<td className={p.unrealizedPnl >= 0 ? "long" : "short"}>
									{usd.format(p.unrealizedPnl)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<p className="empty">No open positions</p>
			)}
		</div>
	);
}

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
	const { hyperliquid, risex } = Route.useLoaderData();
	return (
		<div className="grid">
			<ExchangePositionCard exchange="Extended" positions={[]} />
			<OutOfBoundsCard exchange="Hyperliquid" positions={hyperliquid} />
			<OutOfBoundsCard exchange="Risex" positions={risex} />
		</div>
	);
}
