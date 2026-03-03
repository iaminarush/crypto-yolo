import { createClient } from "@supabase/supabase-js";
import { Handler } from "aws-lambda";
import BigNumber from "bignumber.js";
import ky from "ky";
import { Resource } from "sst";
import { z } from "zod";
import { Database } from "../database.types.ts";
import { ROBOTWEALTH_API } from "./constants";
import { Market } from "./extended/api/markets.schema.ts";
import { getMarkets } from "./extended/api/markets.ts";
import { getOrders } from "./extended/api/orders";
import { getOrderbook } from "./extended/api/orderbook";
import { cancelOrder } from "./extended/api/cancel-order";
import { getPositions, type Position } from "./extended/api/positions";
import { init } from "./extended/init";
import { Decimal, Long } from "./extended/utils/number";
import { clamp, fetchAndParse } from "./util.ts";
import { createLimitOrder } from "./extended/create-limit-order.ts";

const SLEEP_MS = 15000;
const MAX_RUNTIME_MS = 15 * 60 * 1000;

export const tradeYolo: Handler = async () => {
  await init();
  const startTime = Date.now();

  const config = await getConfig();
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

  return Array.from(tickersToRebalance.values());

  let isContinue = true;

  while (
    Date.now() - startTime < MAX_RUNTIME_MS &&
    tickersToRebalance.size > 0
    // isContinue
  ) {
    for (const [ticker, desiredPosition] of tickersToRebalance) {
      const order = await getOrders({ marketsNames: [ticker] });
      // If no order for said ticker, calc orderSize using currentPosition and desiredPosition
      if (order.length === 0) {
        const currentPosition = currentPositions.find(
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

        console.log({ ticker, size, side });

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
    }

    isContinue = false;

    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
  }

  const finalPositions = await getPositions();

  const finalTickersToRebalance = filterTickersToRebalance(
    desiredPositions,
    finalPositions,
  );

  return {
    success: finalTickersToRebalance.size === 0,
    timedOut: Date.now() - startTime >= MAX_RUNTIME_MS,
    runtimeMs: Date.now() - startTime,
    initialTickersToRebalance: tickersToRebalance.size,
    remainingTickers: Array.from(finalTickersToRebalance.keys()),
    positions: finalPositions.map((p) => ({
      market: p.market,
      side: p.side,
      size: p.size.toString(),
      value: p.value.toString(),
    })),
  };
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

    return {
      rwTicker: vw.ticker,
      extendedTicker,
      desiredSize: tokenAllocation,
      upperBound: tokenAllocation.times(Decimal(config.trade_buffer).plus(1)),
      lowerBound: tokenAllocation.times(Decimal(-config.trade_buffer).plus(1)),
      minOrdersize:
        markets.find((m) => m.name === extendedTicker)?.tradingConfig
          .minOrderSize ?? BigNumber(0),
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

    if (currentPosition.plus(size).gt(desiredPosition.upperBound)) {
      size = BigNumber(0);
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

    if (currentPosition.minus(size).lt(desiredPosition.lowerBound)) {
      size = BigNumber(0);
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

const Weight = z.object({
  ticker: z.string(),
  arrival_price: z.number(),
  carry_megafactor: z.number(),
  combo_weight: z.number(),
  momentum_megafactor: z.number(),
  trend_megafactor: z.number(),
});

const WeightsSchema = z.object({
  success: z.boolean(),
  last_updated: z.number(),
  data: z.array(Weight),
});

const getWeights = async () =>
  fetchAndParse(
    () =>
      ky
        .get(`${ROBOTWEALTH_API}/weights`, {
          searchParams: {
            api_key: Resource.ROBOTWEALTH_KEY.value,
          },
        })
        .json(),
    WeightsSchema,
  );

const VolSchema = z.object({
  data: z.array(
    z.object({
      date: z.string(),
      ewvol: z.number(),
      ticker: z.string(),
    }),
  ),
  last_updated: z.number(),
  success: z.boolean(),
});

const getVolatilities = async () =>
  fetchAndParse(
    () =>
      ky
        .get(`${ROBOTWEALTH_API}/volatilities`, {
          searchParams: { api_key: Resource.ROBOTWEALTH_KEY.value },
        })
        .json(),
    VolSchema,
  );

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];

const getWeightsAndVolatilities = async (config: TConfig) => {
  const weights = await getWeights();
  const volatilities = await getVolatilities();
  let totalVol = new BigNumber(0);

  const merged = weights.data.map((w) => {
    const vol = volatilities.data.find((v) => v.ticker === w.ticker);
    if (!vol)
      throw new Error("Non matching ticker between weights and volatilities");

    if (vol.ewvol <= 0)
      throw new Error(`Vol for ${vol.ticker} must be greather than 0`);

    const inverseVol = new BigNumber(1).div(vol.ewvol);
    const comboWeight = new BigNumber(w.trend_megafactor)
      .times(config.trend_weight)
      .plus(new BigNumber(w.momentum_megafactor).times(config.momentum_weight))
      .plus(new BigNumber(w.carry_megafactor).times(config.carry_weight));

    const volScaledWeight = Long(
      clamp(inverseVol.times(comboWeight).toNumber(), -0.25, 0.25),
    );

    totalVol = totalVol.plus(Math.abs(volScaledWeight.toNumber()));

    return {
      ...w,
      ewvol: vol.ewvol,
      inverseVol,
      combo_weight: comboWeight,
      vol_scaled_weight: volScaledWeight,
    };
  });

  if (totalVol.gt(1))
    return merged.map((m) => {
      const volScaledWeight = new BigNumber(m.vol_scaled_weight).div(totalVol);
      const dollarAllocation = volScaledWeight.times(config.allocation);

      return {
        ...m,
        vol_scaled_weight: volScaledWeight,
        dollar_allocation: dollarAllocation,
        token_allocation: dollarAllocation.div(m.arrival_price),
      };
    });
  else
    return merged.map((m) => {
      const dollarAllocation = new BigNumber(m.vol_scaled_weight).times(
        config.allocation,
      );
      return {
        ...m,
        dollar_allocation: dollarAllocation,
        token_allocation: dollarAllocation.div(m.arrival_price),
      };
    });
};

const supabaseUrl = "https://lapkwtulywsjfjogngcx.supabase.co";
const supabaseKey = Resource.SUPABASE_KEY.value;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

export const getConfig = async () => {
  const { data, error } = await supabase
    .from("exchange")
    .select()
    .eq("exchange", "extended")
    .single();

  if (!data) throw new Error("No exchange config in DB");

  if (data.carry_weight + data.momentum_weight + data.trend_weight !== 1)
    throw new Error("Config weights does not add up to 1");

  return data;
};

export const getTickers = async () => {
  const { data, error } = await supabase.from("ticker").select();

  if (!data) throw new Error("No exchange config in DB");

  return data;
};
