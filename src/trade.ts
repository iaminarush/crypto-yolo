import { createClient } from "@supabase/supabase-js";
import { Handler } from "aws-lambda";
import BigNumber from "bignumber.js";
import ky from "ky";
import { Resource } from "sst";
import { z } from "zod";
import { Database } from "../database.types.ts";
import { ROBOTWEALTH_API } from "./constants";
import { cancelOrder } from "./extended/api/cancel-order";
import { getOrderbook } from "./extended/api/orderbook";
import { getOrder, getOrders } from "./extended/api/orders";
import { getPositions, type Position } from "./extended/api/positions";
import { createLimitOrder } from "./extended/create-limit-order";
import { init } from "./extended/init";
import { type OrderSide } from "./extended/models/order.types.ts";
import { Decimal, Long } from "./extended/utils/number";
import { clamp, fetchAndParse } from "./util.ts";
import { getMarkets } from "./extended/api/markets.ts";
import { Market } from "./extended/api/markets.schema.ts";

const SLEEP_MS = 1000;
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

  let isContinue = true;

  while (
    Date.now() - startTime < MAX_RUNTIME_MS &&
    tickersToRebalance.size > 0 &&
    isContinue
  ) {
    for (const [ticker, desiredPosition] of tickersToRebalance) {
      // TODO: implement logic
      // If no order for said ticker, calc orderSize using currentPosition and desiredPosition
      // If exisitng order, use qty - filledQty as size

      const order = await getOrders({ marketsNames: [ticker] });
      if (order.length === 0) {
        const currentPosition = currentPositions.find(
          (p) => p.market === ticker,
        );
        const orderSize = calculateOrderSize(
          desiredPosition,
          currentPosition
            ? currentPosition.size.times(
                currentPosition.side === "LONG" ? 1 : -1,
              )
            : BigNumber(0),
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    isContinue = false;
  }

  return;
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

  if (currentPosition.lte(desiredPosition.lowerBound)) {
    const gap = desiredPosition.lowerBound.minus(currentPosition);
    let size = gap.lt(desiredPosition.minOrdersize)
      ? desiredPosition.minOrdersize
      : gap;

    if (currentPosition.plus(size).gt(desiredPosition.upperBound)) {
      size = BigNumber(0);
    }

    return { size, side: "BUY" };
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
