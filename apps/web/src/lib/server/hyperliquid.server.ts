/**
 * SERVER-ONLY: Hyperliquid positions read.
 *
 * Uses the public Info API — no signing or private key required, only the
 * wallet address (which is public on-chain data). Imported exclusively from
 * server functions so it never reaches the browser bundle.
 */
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { env } from "~/lib/env";

export type HyperliquidPositions = {
	positions: Array<{
		coin: string;
		side: "LONG" | "SHORT";
		size: string;
		entryPx: string;
		markPx: string | null;
		positionValue: string;
		unrealizedPnl: string;
		liquidationPx: string;
		leverage: string;
	}>;
	accountValue: string;
	wallet: string;
};

export async function getHyperliquidPositions(): Promise<HyperliquidPositions> {
	const wallet = env.HYPERLIQUID_WALLET;

	const transport = new HttpTransport();
	const client = new InfoClient({ transport });
	const [state, mids] = await Promise.all([
		client.clearinghouseState({ user: wallet }),
		client.allMids(),
	]);

	const positions = (state.assetPositions ?? []).map(({ position }) => {
		const size = Number(position.szi);
		return {
			coin: position.coin,
			side: size >= 0 ? ("LONG" as const) : ("SHORT" as const),
			size: Math.abs(size).toString(),
			entryPx: String(position.entryPx),
			markPx: mids[position.coin] ?? null,
			positionValue: String(position.positionValue),
			unrealizedPnl: String(position.unrealizedPnl),
			liquidationPx: String(position.liquidationPx),
			leverage: `${position.leverage?.value ?? ""}x`,
		};
	});

	return {
		positions,
		accountValue: String(state.marginSummary?.accountValue ?? ""),
		wallet,
	};
}
