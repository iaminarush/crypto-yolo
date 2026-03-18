import type { Handler } from "aws-lambda";
import BigNumber from "bignumber.js";
import type { Database } from "../database.types.ts";
import { getConfig, getTickers, getWeightsAndVolatilities } from "./api.ts";
import { cancelOrder } from "./extended/api/cancel-order";
import type { Market } from "./extended/api/markets.schema.ts";
import { getMarkets } from "./extended/api/markets.ts";
import { massCancel } from "./extended/api/mass-cancel.ts";
import { getOrderbook } from "./extended/api/orderbook";
import { getOrders } from "./extended/api/orders";
import { getPositions, type Position } from "./extended/api/positions";
import { createLimitOrder } from "./extended/create-limit-order.ts";
import { createMarketOrder } from "./extended/create-market-order.ts";
import { init } from "./extended/init";
import { Decimal } from "./extended/utils/number";
import { roundToMinChange } from "./extended/utils/round-to-min-change.ts";
import { sendTelegramMessage } from "./util.ts";

const SLEEP_MS = 1000;
const MAX_RUNTIME_MS = 10 * 60 * 1000;

export const handler: Handler = async () => {
  await init();
  const startTime = Date.now();

  await sendTelegramMessage("Extended Lambda Started").catch(console.error);

  const config = await getConfig("extended");
  const volAndWeight = await getWeightsAndVolatilities(config);
  const tickers = await getTickers();
  const currentPositions = await getPositions();
  const rawMarkets = await getMarkets();
  const markets = rawMarkets.filter((m) => m.status === "ACTIVE");

  const desiredPositions = calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    markets,
  );

  const tickersToRebalance = filterTickersToRebalance(
    desiredPositions,
    currentPositions,
  );

  // return Array.from(tickersToRebalance.values());

  while (
    Date.now() - startTime < MAX_RUNTIME_MS &&
    tickersToRebalance.size > 0
  ) {
    for (const [ticker, desiredPosition] of tickersToRebalance) {
      const order = await getOrders({ marketsNames: [ticker] });
      if (order.length === 0) {
        const updatedPositions = await getPositions();
        const currentPosition = updatedPositions.find(
          (p) => p.market === ticker,
        );
        const { size, side } = calculateOrderSize(
          desiredPosition,
          currentPosition
            ? currentPosition.size.times(
                currentPosition.side === "LONG" ? 1 : -1,
              )
            : BigNumber(0),
        );

        if (size.gt(0)) {
          const limitOrder = await createLimitOrder({
            ticker,
            size,
            side,
          });

          if (limitOrder.status === "skipped") {
            tickersToRebalance.delete(ticker);
          }
        } else {
          tickersToRebalance.delete(ticker);
        }
      } else {
        const existingOrder = order[0];

        if (existingOrder.status === "FILLED") {
          tickersToRebalance.delete(ticker);
          continue;
        }

        if (existingOrder.status === "CANCELLED") {
          continue;
        }

        const orderbook = await getOrderbook(ticker);
        const bestPrice =
          existingOrder.side === "BUY"
            ? orderbook.bid[0].price
            : orderbook.ask[0].price;

        if (existingOrder.price && !existingOrder.price.eq(bestPrice)) {
          try {
            await cancelOrder(existingOrder.id.toString());
          } catch (error) {
            console.error(`Cancel failed for ${existingOrder.id}:`, error);
            continue;
          }

          const updatedPositions = await getPositions({ markets: [ticker] });
          const currentPosition = updatedPositions[0];

          const { size, side } = calculateOrderSize(
            desiredPosition,
            currentPosition
              ? currentPosition.size.times(
                  currentPosition.side === "LONG" ? 1 : -1,
                )
              : BigNumber(0),
          );

          if (size.gt(0)) {
            await createLimitOrder({
              ticker,
              size,
              side,
            });
          } else {
            tickersToRebalance.delete(ticker);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }

  await massCancel();
  const postTradePositions = await getPositions();

  const tickersToMarketOrder = filterTickersToRebalance(
    desiredPositions,
    postTradePositions,
  );

  for (const [ticker, desiredPosition] of tickersToMarketOrder) {
    const currentPosition = postTradePositions.find((p) => p.market === ticker);
    const { size, side } = calculateOrderSize(
      desiredPosition,
      currentPosition
        ? currentPosition.size.times(currentPosition.side === "LONG" ? 1 : -1)
        : BigNumber(0),
    );

    if (size.gt(0)) {
      await createMarketOrder({ ticker, size, side });
    }
  }

  const finalPositions = await getPositions();

  const tickersOutOfBuffer = Array.from(
    filterTickersToRebalance(desiredPositions, finalPositions).values(),
  ).map((fr) => {
    const position = finalPositions.find(
      (fp) => fp.market === fr.extendedTicker,
    );
    const size = BigNumber(
      position
        ? position.side === "LONG"
          ? position.size
          : position.size.times(-1)
        : 0,
    );
    const marketStats = markets.find(
      (m) => m.assetName === fr.extendedTicker,
    )?.marketStats;
    const midPrice = marketStats
      ? marketStats.askPrice.plus(marketStats.bidPrice).div(2)
      : BigNumber(0);

    const gapToLower = size.minus(fr.lowerBound).abs();
    const gapToUpper = fr.upperBound.minus(size).abs();
    const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
    const priceGap = gap.times(midPrice).toNumber();

    return { ...fr, size, priceGap };
  });

  const result: TradeResult = {
    success: tickersToRebalance.size === 0,
    timedOut: Date.now() - startTime >= MAX_RUNTIME_MS,
    runtimeMs: Date.now() - startTime,
    remainingTickers: Array.from(tickersToRebalance.keys()),
    positions: finalPositions.map((p) => ({
      market: p.market,
      side: p.side,
      size: p.size.toString(),
      value: p.value.toString(),
    })),
  };

  const runtimeSec = Math.floor(result.runtimeMs / 1000);
  const minutes = Math.floor(runtimeSec / 60);
  const seconds = runtimeSec % 60;

  const status = result.success ? "Success" : "Failed";
  const timeout = result.timedOut ? " (timed out)" : "";
  const remainingList =
    result.remainingTickers.length > 0
      ? result.remainingTickers.join(", ")
      : "None";
  const outOfBoundsList =
    tickersOutOfBuffer.length > 0
      ? tickersOutOfBuffer
          .map((t) => `${t.extendedTicker} $${t.priceGap}`)
          .join(", ")
      : "None";

  const message = `
  Extended Trading Complete

  ${status}${timeout}
  Runtime: ${minutes}m ${seconds}s
  Remaining: ${remainingList}
  Positions Out of Bounds: ${outOfBoundsList}`;

  await sendTelegramMessage(message).catch(console.error);

  return result;
};

const calculateDesiredPositions = (
  volAndWeight: Awaited<ReturnType<typeof getWeightsAndVolatilities>>,
  tickers: Awaited<ReturnType<typeof getTickers>>,
  config: Database["public"]["Tables"]["exchange"]["Row"],
  markets: Market[],
) => {
  const tickerMap = new Map(
    tickers
      .filter((t) => markets.some((m) => m.name === t.extended_ticker))
      .map((t) => [t.rbw_ticker, t.extended_ticker]),
  );

  return volAndWeight.map((vw) => {
    const extendedTicker = tickerMap.get(vw.ticker);
    if (!extendedTicker) throw new Error(`No extended ticker for ${vw.ticker}`);

    const tokenAllocation =
      "token_allocation" in vw
        ? (vw.token_allocation as unknown as BigNumber)
        : new BigNumber(0);

    const isPositive = tokenAllocation.gte(0);

    const market = markets.find((m) => m.name === extendedTicker);

    return {
      rwTicker: vw.ticker,
      extendedTicker,
      desiredSize: tokenAllocation,
      upperBound: tokenAllocation.times(
        Decimal(isPositive ? config.trade_buffer : -config.trade_buffer).plus(
          1,
        ),
      ),
      lowerBound: tokenAllocation.times(
        Decimal(isPositive ? -config.trade_buffer : config.trade_buffer).plus(
          1,
        ),
      ),
      minOrdersize: market ? market.tradingConfig.minOrderSize : BigNumber(0),
      minOrdersizeChange: market
        ? market.tradingConfig.minOrderSizeChange
        : BigNumber(0),
    };
  });
};

type TDesiredPosition = ReturnType<typeof calculateDesiredPositions>[number];

const calculateOrderSize = (
  desiredPosition: TDesiredPosition,
  currentPosition: BigNumber,
): { size: BigNumber; side: "BUY" | "SELL" } => {
  if (
    currentPosition.gte(desiredPosition.lowerBound) &&
    currentPosition.lte(desiredPosition.upperBound)
  ) {
    return { size: BigNumber(0), side: "BUY" };
  }

  if (currentPosition.lt(desiredPosition.lowerBound)) {
    const gap = desiredPosition.lowerBound.minus(currentPosition);

    let size = gap.lt(desiredPosition.minOrdersize)
      ? desiredPosition.minOrdersize
      : gap;

    size = roundToMinChange(
      size,
      desiredPosition.minOrdersizeChange,
      Decimal.ROUND_UP,
    );

    const roundedDown = roundToMinChange(
      size,
      desiredPosition.minOrdersizeChange,
      Decimal.ROUND_DOWN,
    );

    if (currentPosition.plus(size).gt(desiredPosition.upperBound)) {
      if (currentPosition.plus(roundedDown).gt(desiredPosition.upperBound)) {
        size = BigNumber(0);
      } else {
        size = roundedDown;
      }
    }

    return { size, side: "BUY" };
  }

  if (currentPosition.gt(desiredPosition.upperBound)) {
    const gap = desiredPosition.upperBound
      .minus(currentPosition)
      .absoluteValue();

    let size = gap.lt(desiredPosition.minOrdersize)
      ? desiredPosition.minOrdersize
      : gap;

    size = roundToMinChange(
      size,
      desiredPosition.minOrdersizeChange,
      Decimal.ROUND_UP,
    );

    const roundedDown = roundToMinChange(
      size,
      desiredPosition.minOrdersizeChange,
      Decimal.ROUND_DOWN,
    );

    if (currentPosition.minus(size).lt(desiredPosition.lowerBound)) {
      if (currentPosition.minus(roundedDown).lt(desiredPosition.lowerBound)) {
        size = BigNumber(0);
      } else {
        size = roundedDown;
      }
    }

    return { size, side: "SELL" };
  }

  return { size: BigNumber(0), side: "BUY" };
};

const filterTickersToRebalance = (
  desiredPositions: TDesiredPosition[],
  currentPositions: Position[],
) => {
  const positionMap = new Map(
    currentPositions.map((p) => [
      p.market,
      p.side === "LONG" ? p.size : p.size.multipliedBy(-1),
    ]),
  );

  const result = new Map<string, TDesiredPosition>();

  for (const dp of desiredPositions) {
    const currentSize = positionMap.get(dp.extendedTicker);

    if (currentSize === undefined) {
      result.set(dp.extendedTicker, dp);
      continue;
    }

    if (currentSize.gte(dp.lowerBound) && currentSize.lte(dp.upperBound)) {
      continue;
    }

    result.set(dp.extendedTicker, dp);
  }

  return result;
};

type TradeResult = {
  success: boolean;
  timedOut: boolean;
  runtimeMs: number;
  remainingTickers: string[];
  positions: { market: string; side: string; size: string; value: string }[];
};
