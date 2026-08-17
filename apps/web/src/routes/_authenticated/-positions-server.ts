import {
	InfoClient as HLInfoClient,
	HttpTransport,
	type MetaResponse,
} from "@nktkas/hyperliquid";
import { createServerFn } from "@tanstack/react-start";
import BN from "bignumber.js";
import ccxt, { type MarketInterface } from "ccxt";
import ky from "ky";
import {
	formatWad,
	InfoClient as RisexInfoClient,
	type Market as RisexMarket,
} from "risex-client";
import { requireAuth } from "~/lib/auth.functions";
import type { Database } from "~/lib/database.types";
import { env } from "~/lib/env";
import {
	getConfig,
	getDemeanedWeightsAndVols,
	getTickers,
	getWeights,
	getWeightsAndVolatilities,
} from "~/lib/util";

const WALLET = env.WALLET_ADDRESS;

export const getHlData = createServerFn()
	.middleware([requireAuth])
	.handler(async () => {
		const transport = new HttpTransport();
		const client = new HLInfoClient({ transport });
		const config = await getConfig("hyperliquid");
		const volAndWeight = await getWeightsAndVolatilities(config);
		const tickers = await getTickers();
		const { assetPositions: currentPositions } =
			await client.clearinghouseState({
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

export const getRisexData = createServerFn()
	.middleware([requireAuth])
	.handler(async () => {
		const info = new RisexInfoClient({ baseUrl: "https://api.rise.trade" });
		const config = await getConfig("risex");
		const weights = await getWeights();
		const markets = await info.getMarkets();
		const tickers = await getTickers();

		const currentPositions = await info.getAllPositions(WALLET);

		const filteredMarkets = tickers
			.filter(
				(t) =>
					markets.some((m) => m.market_id === t.risex_ticker) &&
					weights.data.some((w) => w.ticker === t.rbw_ticker),
			)
			.map((fm) => fm.rbw_ticker);

		const volAndWeight = await getDemeanedWeightsAndVols(
			config,
			filteredMarkets,
		);

		const desiredPositions = getRisexTarget(
			volAndWeight,
			tickers,
			config,
			markets,
		);

		const result = [];

		for (const dp of desiredPositions) {
			const position = currentPositions.find(
				(cp) => cp.market_id === dp.exchangeTicker,
			);
			const currentSize = BN(position?.size ? formatWad(position.size) : 0);

			if (currentSize.gte(dp.lowerBound) && currentSize.lte(dp.upperBound)) {
				continue;
			}

			const book = await info.getOrderbook(Number(dp.exchangeTicker));
			const midPrice =
				(Number(book.bids[0].price) + Number(book.asks[0].price)) / 2;
			const gapToLower = currentSize.minus(dp.lowerBound).abs();
			const gapToUpper = dp.upperBound.minus(currentSize).abs();
			const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
			const priceGap = gap.times(midPrice).toNumber();

			result.push({ ticker: dp.rwTicker, priceGap });
		}
		return result;
	});

const getRisexTarget = (
	volAndWeight: Awaited<ReturnType<typeof getDemeanedWeightsAndVols>>,
	tickers: Awaited<ReturnType<typeof getTickers>>,
	config: Database["public"]["Tables"]["exchange"]["Row"],
	markets: RisexMarket[],
) => {
	const tickerMap = new Map(
		tickers
			.filter((t) => markets.some((m) => m.market_id === t.risex_ticker))
			.map((t) => [t.rbw_ticker, t.risex_ticker]),
	);

	return volAndWeight.map((vw) => {
		const exchangeTicker = tickerMap.get(vw.ticker);
		if (!exchangeTicker) throw new Error(`No risex ticker for ${vw.ticker}`);

		const tokenAllocation = vw.token_allocation;

		const isPositive = tokenAllocation.gte(0);

		const market = markets.find((m) => m.market_id === exchangeTicker);
		if (!market) throw new Error(`No risex market for ${vw.ticker}`);

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
			minOrdersize: market.config.min_order_size,
			stepSize: market.config.step_size,
			stepPrice: market.config.step_price,
		};
	});
};

export const getExtendedData = createServerFn()
	.middleware([requireAuth])
	.handler(async () => {
		const client = new ccxt.extended({
			apiKey: env.EXTENDED_API_KEY,
			userAgent: "crypto-yolo/1.0 (ccxt)",
		});
		const config = await getConfig("extended");
		const volAndWeight = await getWeightsAndVolatilities(config);
		const tickers = await getTickers();
		const currentPositions = await client.fetchPositions();
		const rawMarkets = await client.fetchMarkets();
		const markets = rawMarkets.filter(
			(m) => m?.active === true,
		) as MarketInterface[];

		const desiredPositions = getExtendedTarget(
			volAndWeight,
			tickers,
			config,
			markets,
		);

		const result = [];

		for (const dp of desiredPositions) {
			const position = currentPositions.find(
				(cp) => cp.info.market === dp.exchangeTicker,
			);
			const currentSize = BN(position?.contracts ?? 0).multipliedBy(
				position?.side === "short" ? -1 : 1,
			);

			if (currentSize.gte(dp.lowerBound) && currentSize.lte(dp.upperBound)) {
				continue;
			}

			const marketStats = markets.find((m) => m.id === dp.exchangeTicker)?.info
				.marketStats;
			const askPrice = BN(marketStats.askPrice ?? 0);
			const bidPrice = BN(marketStats.bidPrice ?? 0);
			const midPrice = askPrice.plus(bidPrice).div(2);
			const gapToLower = currentSize.minus(dp.lowerBound).abs();
			const gapToUpper = dp.upperBound.minus(currentSize).abs();
			const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
			const priceGap = gap.times(midPrice).toNumber();

			result.push({ ticker: dp.rwTicker, priceGap });
		}

		return result;
	});

const getExtendedTarget = (
	volAndWeight: Awaited<ReturnType<typeof getWeightsAndVolatilities>>,
	tickers: Awaited<ReturnType<typeof getTickers>>,
	config: Database["public"]["Tables"]["exchange"]["Row"],
	markets: MarketInterface[],
) => {
	const tickerMap = new Map(
		tickers
			.filter((t) => markets.some((m) => m.id === t.extended_ticker))
			.map((t) => [t.rbw_ticker, t.extended_ticker]),
	);

	return volAndWeight.map((vw) => {
		const extendedTicker = tickerMap.get(vw.ticker);
		if (!extendedTicker) throw new Error(`No extended ticker for ${vw.ticker}`);

		const tokenAllocation = vw.token_allocation;

		const isPositive = tokenAllocation.gte(0);

		const market = markets.find((m) => m.id === extendedTicker);

		return {
			rwTicker: vw.ticker,
			exchangeTicker: extendedTicker,
			desiredSize: tokenAllocation,
			upperBound: tokenAllocation.times(
				BN(isPositive ? config.trade_buffer : -config.trade_buffer).plus(1),
			),
			lowerBound: tokenAllocation.times(
				BN(isPositive ? -config.trade_buffer : config.trade_buffer).plus(1),
			),
			minOrdersize: market ? BN(market.contractSize ?? 0) : BN(0),
			minOrdersizeChange: market ? BN(market.precision.amount ?? 0) : BN(0),
		};
	});
};

export const EXCHANGES = ["extended", "hyperliquid", "risex"] as const;

export const triggerTrade = createServerFn({ method: "POST" })
	.middleware([requireAuth])
	.validator((input: { exchange: (typeof EXCHANGES)[number] }) => input)
	.handler(async ({ data }) => {
		await ky
			.post(env.LAMBDA_URL, {
				headers: { authorization: `Bearer ${env.URL_LAMBDA_KEY}` },
				json: { exchange: data.exchange },
			})
			.json();

		return { accepted: true, exchange: data.exchange };
	});
