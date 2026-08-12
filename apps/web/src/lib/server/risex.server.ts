/**
 * SERVER-ONLY: RiseX positions read.
 *
 * Uses the public InfoClient — getAllPositions only needs the account
 * (wallet) address, no private key. Sizes/prices are WAD-encoded (18
 * decimals) and converted with formatWad. Imported exclusively from server
 * functions so it never reaches the browser bundle.
 */
import { InfoClient, formatWad } from "risex-client";
import { env } from "~/lib/env";

export type RisexPositions = {
	positions: Array<{
		marketId: string;
		side: "LONG" | "SHORT";
		size: string;
		entryPrice: string;
		markPrice: string | null;
		unrealizedPnl: string | null;
		liquidationPrice: string | null;
		leverage: string | null;
	}>;
};

export async function getRisexPositions(): Promise<RisexPositions> {
	const wallet = env.RISEX_WALLET ?? env.HYPERLIQUID_WALLET;

	const info = new InfoClient({ baseUrl: "https://api.rise.trade" });
	const raw = await info.getAllPositions(wallet);

	const positions = raw.map((p) => ({
		marketId: String(p.market_id),
		// risex-client Side enum: 0 = Long, 1 = Short
		side: p.side === 1 ? ("SHORT" as const) : ("LONG" as const),
		size: formatWad(p.size),
		entryPrice: formatWad(p.entry_price),
		markPrice: p.mark_price ? formatWad(p.mark_price) : null,
		unrealizedPnl: p.unrealized_pnl ? formatWad(p.unrealized_pnl) : null,
		liquidationPrice: p.liquidation_price
			? formatWad(p.liquidation_price)
			: null,
		leverage: p.leverage ? formatWad(p.leverage) : null,
	}));

	return { positions };
}
