import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/")({
	component: Home,
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

function Home() {
	return (
		<div className="grid">
			<ExchangePositionCard exchange="Extended" positions={[]} />
			<ExchangePositionCard exchange="Hyperliquid" positions={[]} />
			<ExchangePositionCard exchange="Risex" positions={[]} />
		</div>
	);
}
