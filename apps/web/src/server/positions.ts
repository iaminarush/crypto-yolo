/**
 * Server functions — the only boundary through which the dashboard talks to
 * exchanges and Supabase. Handlers run exclusively on the server (they are
 * replaced with RPC stubs in client bundles), so private keys and API keys
 * read from process.env never reach the browser.
 */
import { createServerFn } from "@tanstack/react-start";
import { getExtendedPositions } from "~/lib/server/extended.server";
import { getHyperliquidPositions } from "~/lib/server/hyperliquid.server";
import { getRisexPositions } from "~/lib/server/risex.server";
import { getSupabase } from "~/lib/supabase";

/** Canonical position row rendered by the dashboard, regardless of exchange. */
export type PositionRow = {
	market: string;
	side: "LONG" | "SHORT";
	size: string;
	entryPrice: string;
	markPrice: string | null;
	unrealizedPnl: string | null;
	liquidationPrice: string | null;
	leverage: string | null;
};

/** Per-exchange result block. `error` is always present so the UI can render
 *  an unconfigured/failed exchange as a degraded card instead of crashing. */
export type ExchangeBlock = {
	positions: PositionRow[];
	error: string | null;
	meta: string | null;
};

type Settled<T> = PromiseSettledResult<T>;

/** Wrap a possibly-sync-throwing producer into a settled promise, so a
 *  missing env var (e.g. unconfigured Supabase) degrades a card instead of
 *  crashing the whole page. */
const settled = <T>(fn: () => PromiseLike<T>): Promise<Settled<T>> =>
	Promise.resolve()
		.then(fn)
		.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(reason) => ({ status: "rejected" as const, reason }),
		);

const block = <T>(
	result: Settled<T>,
	onOk: (value: T) => ExchangeBlock,
): ExchangeBlock =>
	result.status === "fulfilled"
		? onOk(result.value)
		: { positions: [], error: String(result.reason), meta: null };

export const getDashboardData = createServerFn({ method: "GET" }).handler(
	async () => {
		const [configsRes, tickersRes, hyperliquidRes, extendedRes, risexRes] =
			await Promise.all([
				settled(() => getSupabase().from("exchange").select()),
				settled(() => getSupabase().from("ticker").select()),
				settled(() => getHyperliquidPositions()),
				settled(() => getExtendedPositions()),
				settled(() => getRisexPositions()),
			]);

		return {
			configs: configsRes.status === "fulfilled" ? configsRes.value.data : null,
			tickers: tickersRes.status === "fulfilled" ? tickersRes.value.data : null,
			hyperliquid: block(hyperliquidRes, (r) => ({
				positions: r.positions.map((p) => ({
					market: p.coin,
					side: p.side,
					size: p.size,
					entryPrice: p.entryPx,
					markPrice: p.markPx,
					unrealizedPnl: p.unrealizedPnl,
					liquidationPrice: p.liquidationPx,
					leverage: p.leverage,
				})),
				meta: `Account value: $${r.accountValue}`,
				error: null,
			})),
			extended: block(extendedRes, (r) => ({
				positions: r.positions.map((p) => ({
					market: p.market,
					side: p.side,
					size: p.size,
					entryPrice: p.openPrice,
					markPrice: p.markPrice,
					unrealizedPnl: p.unrealisedPnl,
					liquidationPrice: p.liquidationPrice ?? null,
					leverage: p.leverage,
				})),
				meta: r.balance
					? `Equity: $${r.balance.equity} · Leverage: ${r.balance.leverage}x`
					: null,
				error: null,
			})),
			risex: block(risexRes, (r) => ({
				positions: r.positions.map((p) => ({
					market: p.marketId,
					side: p.side,
					size: p.size,
					entryPrice: p.entryPrice,
					markPrice: p.markPrice,
					unrealizedPnl: p.unrealizedPnl,
					liquidationPrice: p.liquidationPrice,
					leverage: p.leverage,
				})),
				meta: null,
				error: null,
			})),
		};
	},
);
