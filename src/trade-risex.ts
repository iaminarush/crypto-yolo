import type { Handler } from "aws-lambda";
import BN from "bignumber.js";
import type { Database } from "database.types";
import ky from "ky";
import {
  ExchangeClient,
  InfoClient,
  type Market,
  type Position,
  formatWad,
} from "risex-client";
import { Resource } from "sst";
import { z } from "zod";
import {
  getConfig,
  getDemeanedWeightsAndVols,
  getTickers,
  getWeights,
} from "./api";
import { fetchAndParse, sendTelegramMessage } from "./util";

const SLEEP_MS = 2250;
const MAX_RUNTIME_MS = 10 * 60 * 1000;

const PortfolioDetailsSchema = z.object({
  summary: z.object({
    account_leverage: z.string(),
  }),
});

export const handler: Handler = async () => {
  const startTime = Date.now();
  sendTelegramMessage("Risex Lambda Started");

  const WALLET = Resource.HYPERLIQUID_WALLET.value;
  const API_WALLET = Resource.RISEX_WALLET.value;
  const info = new InfoClient({ baseUrl: "https://api.rise.trade" });
  const client = new ExchangeClient({
    account: API_WALLET,
    signerKey: Resource.RISEX_API_KEY.value,
  });
  await client.init();
  const config = await getConfig("risex");
  const weights = await getWeights();
  const markets = await info.getMarkets();
  const tickers = await getTickers();

  const positions = await info.getAllPositions(WALLET);

  const filteredMarkets = tickers
    .filter(
      (t) =>
        markets.some((m) => m.market_id === t.risex_ticker) &&
        weights.data.some((w) => w.ticker === t.rbw_ticker),
    )
    .map((fm) => fm.rbw_ticker);

  const volAndWeight = await getDemeanedWeightsAndVols(config, filteredMarkets);

  const desiredPositions = calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    markets,
  );

  const tickersToRebalance = filterTickersToRebalance(
    desiredPositions,
    positions,
  );

  while (
    Date.now() - startTime < MAX_RUNTIME_MS &&
    tickersToRebalance.size > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    const updatedPositions = await info.getAllPositions(WALLET);
    const orders = await info.getOpenOrders(WALLET);
    for (const [ticker, desiredPosition] of tickersToRebalance) {
      const order = orders.find((o) => `${o.market_id}` === ticker);

      if (!order) {
        const currentPosition = updatedPositions.find(
          (p) => p.market_id === ticker,
        );

        const { side, size } = calculateOrderSize(
          desiredPosition,
          BN(currentPosition ? formatWad(currentPosition.size) : 0),
        );

        if (size.gt(0)) {
          await createLimitOrder({
            client,
            info,
            side,
            size,
            marketId: ticker,
            stepPrice: desiredPosition.stepPrice,
            stepSize: desiredPosition.stepSize,
          });
        } else {
          tickersToRebalance.delete(ticker);
        }
      } else {
        const book = await info.getOrderbook(Number(ticker));
        const bestPrice =
          order.side === 0 ? book.bids[0].price : book.asks[0].price;

        if (
          bestPrice &&
          BN(order.price_ticks).times(desiredPosition.stepPrice).eq(bestPrice)
        )
          continue;

        try {
          await client.cancelOrder({
            market_id: Number(ticker),
            order_id: order.order_id,
          });
        } catch (error) {
          console.error(`Cancel failed for ${desiredPosition.rwTicker}`, error);
        }

        const currentPosition = updatedPositions.find(
          (p) => p.market_id === ticker,
        );

        const { size, side } = calculateOrderSize(
          desiredPosition,
          BN(currentPosition ? formatWad(currentPosition.size) : 0),
        );

        if (size.gt(0)) {
          await createLimitOrder({
            client,
            info,
            side,
            size,
            marketId: ticker,
            stepPrice: desiredPosition.stepPrice,
            stepSize: desiredPosition.stepSize,
          });
        } else {
          tickersToRebalance.delete(ticker);
        }
      }
    }
  }

  const filteredRisexMarkets = new Set(
    tickers
      .filter((t) => filteredMarkets.includes(t.rbw_ticker))
      .map((t) => t.risex_ticker),
  );
  const openOrders = await info.getOpenOrders(WALLET);
  const marketIds = [
    ...new Set(
      openOrders
        .map((o) => o.market_id)
        .filter((id) => filteredRisexMarkets.has(String(id))),
    ),
  ];
  for (const marketId of marketIds) await client.cancelAllOrders(marketId);

  const postTradePositions = await info.getAllPositions(WALLET);
  const tickersToMarketOrder = filterTickersToRebalance(
    desiredPositions,
    postTradePositions,
  );

  for (const [ticker, desiredPosition] of tickersToMarketOrder) {
    const currentPosition = postTradePositions.find(
      (p) => p.market_id === ticker,
    );
    const { side, size } = calculateOrderSize(
      desiredPosition,
      BN(currentPosition ? formatWad(currentPosition.size) : 0),
    );

    if (size.gt(0)) {
      const sizeSteps = size
        .div(desiredPosition.stepSize)
        .decimalPlaces(0, BN.ROUND_DOWN)
        .toNumber();
      side === "BUY"
        ? await client.marketBuy(Number(ticker), sizeSteps)
        : await client.marketSell(Number(ticker), sizeSteps);
    }
  }

  const finalPositions = await info.getAllPositions(WALLET);

  const tickersOutOfBuffer = await Promise.all(
    Array.from(
      filterTickersToRebalance(desiredPositions, finalPositions).values(),
    ).map(async (fr) => {
      const position = finalPositions.find(
        (fp) => fp.market_id === fr.exchangeTicker,
      );

      const size = BN(formatWad(position?.size || "0"));
      const book = await info.getOrderbook(Number(fr.exchangeTicker));
      const midPrice =
        (Number(book.bids[0].price) + Number(book.asks[0].price)) / 2;

      const gapToLower = size.minus(fr.lowerBound).abs();
      const gapToUpper = fr.upperBound.minus(size).abs();
      const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
      const priceGap = gap.times(midPrice).toNumber();

      return { ...fr, size, priceGap };
    }),
  );

  const runtimeMs = Date.now() - startTime;
  const timedOut = runtimeMs >= MAX_RUNTIME_MS;
  const minutes = Math.floor(runtimeMs / 60000);
  const seconds = Math.floor((runtimeMs % 60000) / 1000);

  const status = tickersToRebalance.size === 0 ? "Success" : "Incomplete";
  const timeout = timedOut ? " (Timed out)" : "";
  const remainingList =
    tickersToRebalance.size > 0
      ? Array.from(tickersToRebalance.keys()).join(", ")
      : "None";
  const outOfBoundsList =
    tickersOutOfBuffer.length > 0
      ? tickersOutOfBuffer
          .map((t) => `${t.exchangeTicker} $${t.priceGap}`)
          .join(", ")
      : "None";

  const {
    summary: { account_leverage },
  } = await fetchAndParse(
    () =>
      ky
        .get("https://api.rise.trade/v1/portfolio/details", {
          searchParams: { account: WALLET },
        })
        .json(),
    PortfolioDetailsSchema,
  );
  const leverage = BN(account_leverage).decimalPlaces(2, BN.ROUND_HALF_UP);

  const message = `
  Risex Trading Complete

  ${status}${timeout}
  Runtime: ${minutes}m ${seconds}s
  Remaining: ${remainingList}
  Positions Out of Bounds: ${outOfBoundsList}
  Leverage: ${leverage}`;

  await sendTelegramMessage(message);

  return { finalPositions, tickersOutOfBuffer };
};

const calculateDesiredPositions = (
  volAndWeight: Awaited<ReturnType<typeof getDemeanedWeightsAndVols>>,
  tickers: Awaited<ReturnType<typeof getTickers>>,
  config: Database["public"]["Tables"]["exchange"]["Row"],
  markets: Market[],
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

type TDesiredPosition = ReturnType<typeof calculateDesiredPositions>[number];

const filterTickersToRebalance = (
  desiredPositions: TDesiredPosition[],
  currentPositions: Position[],
) => {
  const positionMap = new Map(
    currentPositions.map((p) => [p.market_id, BN(formatWad(p.size))]),
  );

  const result = new Map<string, TDesiredPosition>();

  for (const dp of desiredPositions) {
    const currentSize = positionMap.get(dp.exchangeTicker);

    if (currentSize === undefined) {
      result.set(dp.exchangeTicker, dp);
      continue;
    }

    if (currentSize.gte(dp.lowerBound) && currentSize.lte(dp.upperBound)) {
      continue;
    }

    result.set(dp.exchangeTicker, dp);
  }
  return result;
};

function calculateOrderSize(
  desiredPosition: TDesiredPosition,
  currentPosition: BN,
) {
  const { stepSize, lowerBound, upperBound, minOrdersize } = desiredPosition;

  if (currentPosition.gte(lowerBound) && currentPosition.lte(upperBound)) {
    return { size: BN(0), side: "BUY" };
  }

  if (currentPosition.lt(lowerBound)) {
    const gap = lowerBound.minus(currentPosition);

    const size = gap.lt(minOrdersize) ? BN(minOrdersize) : gap;

    const roundedUp = roundToMinOrdersize(size, stepSize, BN.ROUND_UP);
    const roundedDown = roundToMinOrdersize(size, stepSize, BN.ROUND_DOWN);

    if (currentPosition.plus(roundedUp).lt(desiredPosition.upperBound))
      return { size: roundedUp, side: "BUY" };

    if (currentPosition.plus(roundedDown).lt(desiredPosition.upperBound))
      return { size: roundedDown, side: "BUY" };

    return { size: BN(0), side: "BUY" };
  }

  if (currentPosition.gt(desiredPosition.upperBound)) {
    const gap = desiredPosition.upperBound
      .minus(currentPosition)
      .absoluteValue();

    const size = gap.lt(minOrdersize) ? BN(minOrdersize) : gap;

    const roundedUp = roundToMinOrdersize(size, stepSize, BN.ROUND_UP);
    const roundedDown = roundToMinOrdersize(size, stepSize, BN.ROUND_DOWN);

    if (currentPosition.plus(roundedUp).gt(desiredPosition.lowerBound))
      return { size: roundedUp, side: "SELL" };

    if (currentPosition.plus(roundedDown).gt(desiredPosition.lowerBound))
      return { size: roundedDown, side: "SELL" };

    return { size: BN(0), side: "SELL" };
  }
  return { size: BN(0), side: "BUY" };
}

function roundToMinOrdersize(
  size: BN,
  stepSize: string,
  roundingMode: BN.RoundingMode,
) {
  const step = BN(stepSize);
  return size.div(step).decimalPlaces(0, roundingMode).times(step);
}

async function createLimitOrder({
  client,
  info,
  side,
  marketId,
  size,
  stepSize,
  stepPrice,
}: {
  client: ExchangeClient;
  info: InfoClient;
  side: string;
  marketId: string;
  size: BN;
  stepSize: string;
  stepPrice: string;
}) {
  const sizeSteps = size
    .div(stepSize)
    .decimalPlaces(0, BN.ROUND_DOWN)
    .toNumber();
  const book = await info.getOrderbook(Number(marketId));
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  if (!bestBid || !bestAsk)
    throw new Error(`No best bid/ask for market ${marketId}`);
  const price = side === "BUY" ? bestBid : bestAsk;
  const priceTicks = BN(price)
    .div(stepPrice)
    .decimalPlaces(0, BN.ROUND_DOWN)
    .toNumber();

  if (side === "BUY") {
    await client.limitBuy(Number(marketId), sizeSteps, priceTicks, true);
  } else if (side === "SELL") {
    await client.limitSell(Number(marketId), sizeSteps, priceTicks, true);
  }
}
