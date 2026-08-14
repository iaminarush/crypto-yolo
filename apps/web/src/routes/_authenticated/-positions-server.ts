import {
	HttpTransport,
	InfoClient,
	type MetaResponse,
} from "@nktkas/hyperliquid";
import { createServerFn } from "@tanstack/react-start";
import BN from "bignumber.js";
import type { Database } from "~/lib/database.types";
import { env } from "~/lib/env";
import { getConfig, getTickers, getWeightsAndVolatilities } from "~/lib/util";

const WALLET = env.WALLET_ADDRESS;

export const getHLOutOfBounds = createServerFn().handler(async () => {
	const transport = new HttpTransport();
	const client = new InfoClient({ transport });
	const config = await getConfig("hyperliquid");
	const volAndWeight = await getWeightsAndVolatilities(config);
	const tickers = await getTickers();
	const { assetPositions: currentPositions } = await client.clearinghouseState({
		user: WALLET,
	});
	const meta = await client.meta();
	const allMids = await client.allMids();

	const desiredPositions = getHLTarget(
		volAndWeight,
		tickers,
		config,
		meta.universe,
	);

	const result = [];

	for (const dp of desiredPositions) {
		const currentSize = BN(
			currentPositions.find((cp) => cp.position.coin === dp.exchangeTicker)
				?.position.szi || 0,
		);

		if (currentSize.gte(dp.lowerBound) && currentSize.lte(dp.upperBound)) {
			continue;
		}

		const position = currentPositions.find(
			(cp) => cp.position.coin === dp.exchangeTicker,
		)?.position;
		const size = BN(position?.szi || 0);
		const midPrice = allMids[dp.exchangeTicker];
		const gapToLower = size.minus(dp.lowerBound).abs();
		const gapToUpper = dp.upperBound.minus(size).abs();
		const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
		const priceGap = gap.times(midPrice).toNumber();

		result.push({ ticker: dp.rwTicker, priceGap });
	}
	return result;
});

function getHLMinOrderSizeChange(szDecimals: number): BN {
	return new BN(1).dividedBy(new BN(10).pow(szDecimals));
}

const getHLTarget = (
	volAndWeight: Awaited<ReturnType<typeof getWeightsAndVolatilities>>,
	tickers: Awaited<ReturnType<typeof getTickers>>,
	config: Database["public"]["Tables"]["exchange"]["Row"],
	markets: MetaResponse["universe"],
) => {
	const tickerMap = new Map(
		tickers
			.filter((t) => markets.some((m) => m.name === t.hyperliquid_ticker))
			.map((t) => [t.rbw_ticker, t.hyperliquid_ticker]),
	);

	return volAndWeight.map((vw) => {
		const exchangeTicker = tickerMap.get(vw.ticker);
		if (!exchangeTicker)
			throw new Error(`No hyperliquid ticker for ${vw.ticker}`);

		const tokenAllocation = vw.token_allocation;

		const isPositive = tokenAllocation.gte(0);

		const market = markets.find((m) => m.name === exchangeTicker);

		return {
			rwTicker: vw.ticker,
			exchangeTicker,
			desiredSize: tokenAllocation,
			upperBound: tokenAllocation.times(
				BN(isPositive ? config.trade_buffer : -config.trade_buffer).plus(1),
			),
			lowerBound: tokenAllocation.times(
				BN(isPositive ? -config.trade_buffer : config.trade_buffer).plus(1),
			),
			minOrderSizeChange: market
				? getHLMinOrderSizeChange(market.szDecimals)
				: BN(0),
			szDecimals: market ? market.szDecimals : 1,
		};
	});
};
