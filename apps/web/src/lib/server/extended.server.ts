/**
 * SERVER-ONLY: X10 (Extended) positions + balance read.
 *
 * Read-only REST calls authenticated with the API key header. No Starknet
 * signing is needed for reads (that's only required for order/transfer
 * placement). Imported exclusively from server functions so the API key
 * never reaches the browser bundle.
 */
import { z } from "zod";

const DEFAULT_EXTENDED_API = "https://api.starknet.extended.exchange";

const PositionSchema = z.object({
	id: z.union([z.string(), z.number()]),
	accountId: z.union([z.string(), z.number()]),
	market: z.string(),
	side: z.enum(["LONG", "SHORT"]),
	leverage: z.string(),
	size: z.string(),
	value: z.string(),
	openPrice: z.string(),
	markPrice: z.string(),
	liquidationPrice: z.string().optional(),
	unrealisedPnl: z.string(),
	realisedPnl: z.string(),
});

const PositionsResponseSchema = z.object({
	data: z.array(PositionSchema),
});

const BalanceResponseSchema = z.object({
	status: z.enum(["OK", "ERROR"]),
	data: z.object({
		balance: z.string(),
		equity: z.string(),
		availableForTrade: z.string(),
		unrealisedPnl: z.string(),
		leverage: z.string(),
	}),
});

export type ExtendedPositions = {
	positions: Array<z.infer<typeof PositionSchema>>;
	balance: z.infer<typeof BalanceResponseSchema>["data"];
};

export async function getExtendedPositions(): Promise<ExtendedPositions> {
	const apiKey = process.env.EXTENDED_API_KEY;
	if (!apiKey) {
		throw new Error("Missing EXTENDED_API_KEY env var");
	}
	const baseUrl = process.env.EXTENDED_API ?? DEFAULT_EXTENDED_API;

	const headers: Record<string, string> = { "x-api-key": apiKey };
	const signal = AbortSignal.timeout(15_000);

	const [positionsRes, balanceRes] = await Promise.all([
		fetch(`${baseUrl}/api/v1/user/positions`, { headers, signal }),
		fetch(`${baseUrl}/api/v1/user/balance`, { headers, signal }),
	]);

	if (!positionsRes.ok || !balanceRes.ok) {
		throw new Error(
			`Extended API error: positions=${positionsRes.status} balance=${balanceRes.status}`,
		);
	}

	const positions = PositionsResponseSchema.parse(await positionsRes.json());
	const balance = BalanceResponseSchema.parse(await balanceRes.json());

	return { positions: positions.data, balance: balance.data };
}
