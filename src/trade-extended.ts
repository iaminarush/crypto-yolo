import { createClient } from "@supabase/supabase-js";
import type { Handler } from "aws-lambda";
import BigNumber from "bignumber.js";
import ky from "ky";
import { Resource } from "sst";
import { z } from "zod";
import type { Database } from "../database.types.ts";
import { ROBOTWEALTH_API, SUPABASE_URL } from "./constants";
import { cancelOrder } from "./extended/api/cancel-order";
import type { Market } from "./extended/api/markets.schema.ts";
import { getMarkets } from "./extended/api/markets.ts";
import { massCancel } from "./extended/api/mass-cancel.ts";
import { getOrderbook } from "./extended/api/orderbook";
import { getOrders } from "./extended/api/orders";
import { getPositions, type Position } from "./extended/api/positions";
import { createLimitOrder } from "./extended/create-limit-order.ts";
import { init } from "./extended/init";
import { Decimal, Long } from "./extended/utils/number";
import { roundToMinChange } from "./extended/utils/round-to-min-change.ts";
import { clamp, fetchAndParse } from "./util.ts";
import { createMarketOrder } from "./extended/create-market-order.ts";

const SLEEP_MS = 1000;
const MAX_RUNTIME_MS = 10 * 60 * 1000;

export const handler: Handler = async () => {
  await init();
  const startTime = Date.now();

  const startMessage = `Extended Lambda Started!`;
  ky.post(
    `https://api.telegram.org/bot${Resource.TELEGRAM_TOKEN.value}/sendMessage`,
    {
      json: {
        chat_id: Resource.TELEGRAM_ID.value,
        text: startMessage,
      },
    },
  ).catch(console.error);

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

  // return Array.from(tickersToRebalance.values());

  while (
    Date.now() - startTime < MAX_RUNTIME_MS &&
    tickersToRebalance.size > 0
  ) {
    //TODO: Check if rounding up position size will cause position to go over bounds
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

    //TODO: finish post order
    if (size.gt(0)) {
      await createMarketOrder({ ticker, size, side });
    }
  }

  const finalPositions = await getPositions();

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

  await sendTelegramMessage(result).catch(console.error);

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

const supabaseUrl = SUPABASE_URL;
const supabaseKey = Resource.SUPABASE_KEY.value;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

export const getConfig = async () => {
  const { data } = await supabase
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
  const { data } = await supabase.from("ticker").select();

  if (!data) throw new Error("No exchange config in DB");

  return data;
};

type TradeResult = {
  success: boolean;
  timedOut: boolean;
  runtimeMs: number;
  remainingTickers: string[];
  positions: { market: string; side: string; size: string; value: string }[];
};

const sendTelegramMessage = async (result: TradeResult) => {
  const runtimeSec = Math.floor(result.runtimeMs / 1000);
  const minutes = Math.floor(runtimeSec / 60);
  const seconds = runtimeSec % 60;

  const status = result.success ? "Success" : "Failed";
  const timeout = result.timedOut ? " (timed out)" : "";
  const remainingList =
    result.remainingTickers.length > 0
      ? result.remainingTickers.join(", ")
      : "None";

  const message = `Extended Trading Complete!

${status}${timeout}
Runtime: ${minutes}m ${seconds}s
Remaining: ${remainingList}`;

  await ky.post(
    `https://api.telegram.org/bot${Resource.TELEGRAM_TOKEN.value}/sendMessage`,
    {
      json: {
        chat_id: Resource.TELEGRAM_ID.value,
        text: message,
        parse_mode: "HTML",
      },
    },
  );
};
