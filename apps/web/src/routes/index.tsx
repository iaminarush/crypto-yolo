import { createFileRoute } from "@tanstack/react-router";
import type { PositionRow } from "~/server/positions";
import { getDashboardData } from "~/server/positions";

export const Route = createFileRoute("/")({
	loader: () => getDashboardData(),
	component: Home,
});

function PositionsTable({ positions }: { positions: PositionRow[] }) {
	if (positions.length === 0) {
		return <div className="empty">No open positions</div>;
	}

	return (
		<table>
			<thead>
				<tr>
					<th>Market</th>
					<th>Side</th>
					<th>Size</th>
					<th>Entry</th>
					<th>Mark</th>
					<th>uPnL</th>
					<th>Liq.</th>
					<th>Lev.</th>
				</tr>
			</thead>
			<tbody>
				{positions.map((p) => (
					<tr key={`${p.market}-${p.side}`}>
						<td>{p.market}</td>
						<td className={p.side === "LONG" ? "long" : "short"}>{p.side}</td>
						<td>{p.size}</td>
						<td>{fmt(p.entryPrice)}</td>
						<td>{p.markPrice ? fmt(p.markPrice) : "—"}</td>
						<td className={pnlClass(p.unrealizedPnl)}>
							{p.unrealizedPnl ? fmt(p.unrealizedPnl) : "—"}
						</td>
						<td>{p.liquidationPrice ? fmt(p.liquidationPrice) : "—"}</td>
						<td>{p.leverage ?? "—"}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function ErrorNote({ error }: { error: string | null }) {
	if (!error) return null;
	return <div className="error-box">{error}</div>;
}

function Home() {
	const data = Route.useLoaderData();

	return (
		<>
			<h1>Positions</h1>
			<p className="subtitle">
				Live account state across exchanges. Data is read server-side; keys
				never leave the server.
			</p>

			<section className="grid">
				<div className="card">
					<h2>
						Hyperliquid
						{data.hyperliquid.error ? (
							<span className="badge err">unconfigured</span>
						) : (
							<span className="badge ok">live</span>
						)}
					</h2>
					<ErrorNote error={data.hyperliquid.error} />
					{data.hyperliquid.meta && (
						<p className="muted">{data.hyperliquid.meta}</p>
					)}
					<PositionsTable positions={data.hyperliquid.positions} />
				</div>

				<div className="card">
					<h2>
						Extended (X10)
						{data.extended.error ? (
							<span className="badge err">unconfigured</span>
						) : (
							<span className="badge ok">live</span>
						)}
					</h2>
					<ErrorNote error={data.extended.error} />
					{data.extended.meta && <p className="muted">{data.extended.meta}</p>}
					<PositionsTable positions={data.extended.positions} />
				</div>

				<div className="card">
					<h2>
						RiseX
						{data.risex.error ? (
							<span className="badge err">unconfigured</span>
						) : (
							<span className="badge ok">live</span>
						)}
					</h2>
					<ErrorNote error={data.risex.error} />
					<PositionsTable positions={data.risex.positions} />
				</div>

				<div className="card">
					<h2>Config (Supabase)</h2>
					{!data.configs && <div className="empty">No config rows</div>}
					{data.configs && (
						<table>
							<thead>
								<tr>
									<th>Exchange</th>
									<th>Allocation</th>
									<th>Weights (carry/mom/trend)</th>
									<th>Buffer</th>
								</tr>
							</thead>
							<tbody>
								{data.configs.map((c) => (
									<tr key={c.id}>
										<td>{c.exchange}</td>
										<td>${fmt(c.allocation)}</td>
										<td>
											{c.carry_weight}/{c.momentum_weight}/{c.trend_weight}
										</td>
										<td>{c.trade_buffer}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{!data.tickers && <div className="empty">No ticker rows</div>}
					{data.tickers && (
						<p className="muted">{data.tickers.length} tickers mapped</p>
					)}
				</div>
			</section>
		</>
	);
}

const fmt = (v: string | number | null | undefined): string => {
	if (v === null || v === undefined || v === "") return "—";
	const n = Number(v);
	if (!Number.isFinite(n)) return String(v);
	return n.toLocaleString("en-US", {
		maximumFractionDigits: Math.abs(n) < 1 ? 6 : 2,
	});
};

const pnlClass = (v: string | null): string => {
	if (!v) return "";
	const n = Number(v);
	if (n > 0) return "long";
	if (n < 0) return "short";
	return "";
};
