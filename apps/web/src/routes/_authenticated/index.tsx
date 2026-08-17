import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
	type EXCHANGES,
	getExtendedData,
	getHlData,
	getRisexData,
	triggerTrade,
} from "./-positions-server";

export const Route = createFileRoute("/_authenticated/")({
	component: Home,
	pendingComponent: HomePending,
	pendingMs: 150,
	pendingMinMs: 300,
	loader: async () => {
		// One exchange failing shouldn't blank the whole dashboard.
		const orNull = <T,>(fn: () => Promise<T>): Promise<T | null> =>
			fn().catch((e) => {
				console.error(e);
				return null;
			});

		const [extended, hyperliquid, risex] = await Promise.all([
			orNull(getExtendedData),
			orNull(getHlData),
			orNull(getRisexData),
		]);
		return { extended, hyperliquid, risex };
	},
});

type Exchange = (typeof EXCHANGES)[number];

type OutOfBoundsPosition = Awaited<ReturnType<typeof getHlData>>[number];

const EXCHANGE_LABELS: Record<Exchange, string> = {
	extended: "Extended",
	hyperliquid: "Hyperliquid",
	risex: "Risex",
};

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

function OutOfBoundsCard({
	exchange,
	load,
	initialPositions,
}: {
	exchange: Exchange;
	load: () => Promise<OutOfBoundsPosition[]>;
	initialPositions: OutOfBoundsPosition[] | null;
}) {
	const [positions, setPositions] = useState(initialPositions);
	const [refreshing, setRefreshing] = useState(false);
	const [triggering, setTriggering] = useState(false);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			setPositions(await load());
		} catch (e) {
			console.error(e);
		} finally {
			setRefreshing(false);
		}
	};

	const handleTrigger = async () => {
		setTriggering(true);
		try {
			await triggerTrade({ data: { exchange } });
		} catch (e) {
			console.error(e);
		} finally {
			setTriggering(false);
		}
	};

	if (positions === null) {
		return (
			<div className="card">
				<h2>{EXCHANGE_LABELS[exchange]}</h2>
				<p className="empty">Error loading positions</p>
				<div className="card-actions">
					<button
						type="button"
						className="debug-button"
						onClick={handleRefresh}
						disabled={refreshing}
					>
						{refreshing ? "Refreshing…" : "Refresh"}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="card">
			<h2>
				{EXCHANGE_LABELS[exchange]}
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
			<div className="card-actions">
				<button
					type="button"
					className="debug-button"
					onClick={handleRefresh}
					disabled={refreshing}
				>
					{refreshing ? "Refreshing…" : "Refresh"}
				</button>
				<button
					type="button"
					className="debug-button"
					onClick={handleTrigger}
					disabled={triggering}
				>
					{triggering ? "Triggering…" : "Trigger rebalance"}
				</button>
			</div>
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

const fetchByExchange: Record<Exchange, () => Promise<OutOfBoundsPosition[]>> =
	{
		extended: getExtendedData,
		hyperliquid: getHlData,
		risex: getRisexData,
	};

function Home() {
	const { extended, hyperliquid, risex } = Route.useLoaderData();
	return (
		<div className="grid">
			<OutOfBoundsCard
				exchange="extended"
				load={fetchByExchange.extended}
				initialPositions={extended}
			/>
			<OutOfBoundsCard
				exchange="hyperliquid"
				load={fetchByExchange.hyperliquid}
				initialPositions={hyperliquid}
			/>
			<OutOfBoundsCard
				exchange="risex"
				load={fetchByExchange.risex}
				initialPositions={risex}
			/>
		</div>
	);
}
