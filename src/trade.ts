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
import { getOrder } from "./extended/api/orders";
import { getPositions, type Position } from "./extended/api/positions";
import { createLimitOrder } from "./extended/create-limit-order";
import { init } from "./extended/init";
import { type OrderSide } from "./extended/models/order.types.ts";
import { Decimal, Long } from "./extended/utils/number";
import { clamp, fetchAndParse } from "./util.ts";

const SLEEP_MS = 1000;
const MAX_RUNTIME_MS = 15 * 60 * 1000;

interface PendingOrder {
  orderId: string;
  ticker: string;
  side: OrderSide;
  size: BigNumber;
  price: BigNumber;
}

interface OrderDiff {
  extendedTicker: string;
  side: OrderSide;
  size: BigNumber;
}

export const tradeYolo: Handler = async () => {
  await init();
  const startTime = Date.now();

  //TODO: Add trade buffer
  const config = await getConfig();
  const volAndWeight = await getWeightsAndVolatilities(config);
  const tickers = await getTickers();
  const currentPositions = await getPositions();

  const desiredPositions = mapVolAndWeightToDesiredPositions(
    volAndWeight,
    tickers,
    config,
  );
  const orderDiffs = calculateOrderDiffs(desiredPositions, currentPositions);

  return desiredPositions;

  const pendingOrders = new Map<string, PendingOrder>();

  for (const diff of orderDiffs) {
    if (diff.size.lte(0)) continue;

    try {
      const orderbook = await getOrderbook(diff.extendedTicker);
      const price =
        diff.side === "BUY" ? orderbook.bid[0].price : orderbook.ask[0].price;

      const orderResult = await createLimitOrder({
        ticker: diff.extendedTicker,
        side: diff.side,
        orderSize: Decimal(diff.size),
      });

      if (orderResult.status === "error") {
        console.error(
          `Order failed for ${diff.extendedTicker}:`,
          (orderResult as { error: string }).error,
        );
        continue;
      }

      const successResult = orderResult as { status: "success"; id: string };
      pendingOrders.set(successResult.id, {
        orderId: successResult.id,
        ticker: diff.extendedTicker,
        side: diff.side,
        size: diff.size,
        price: price as unknown as BigNumber,
      });
    } catch {
      continue;
    }
  }

  while (Date.now() - startTime < MAX_RUNTIME_MS && pendingOrders.size > 0) {
    for (const [orderId, order] of pendingOrders) {
      try {
        const status = await getOrder(orderId);

        if (status.status === "FILLED" || status.status === "CANCELLED") {
          pendingOrders.delete(orderId);
          continue;
        }

        const orderbook = await getOrderbook(order.ticker);
        const bestPrice =
          order.side === "BUY"
            ? (orderbook.bid[0].price as unknown as BigNumber)
            : (orderbook.ask[0].price as unknown as BigNumber);

        if (!order.price.eq(bestPrice)) {
          const result = await createLimitOrder({
            ticker: order.ticker,
            side: order.side,
            orderSize: Decimal(order.size),
            cancelId: orderId,
          });

          if (result.status === "success") {
            const successResult = result as { status: "success"; id: string };
            order.orderId = successResult.id;
            order.price = bestPrice;
          }
        }
      } catch {
        continue;
      }
    }

    if (pendingOrders.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
  }

  const remainingOrders = Array.from(pendingOrders.values());

  for (const order of remainingOrders) {
    try {
      await cancelOrder(order.orderId);
    } catch {
      continue;
    }
  }

  return {
    success: pendingOrders.size === 0,
    runtimeMs: Date.now() - startTime,
    pendingOrders: remainingOrders.length,
    orders: remainingOrders.map((o) => ({
      orderId: o.orderId,
      ticker: o.ticker,
      side: o.side,
      size: o.size.toString(),
    })),
  };
};

const mapVolAndWeightToDesiredPositions = (
  volAndWeight: Awaited<ReturnType<typeof getWeightsAndVolatilities>>,
  tickers: Awaited<ReturnType<typeof getTickers>>,
  config: Database["public"]["Tables"]["exchange"]["Row"],
) => {
  const tickerMap = new Map(
    tickers.map((t) => [t.rbw_ticker, t.extended_ticker]),
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
    };
  });
};

const calculateOrderDiffs = (
  desiredPositions: ReturnType<typeof mapVolAndWeightToDesiredPositions>,
  currentPositions: Position[],
): OrderDiff[] => {
  const positionMap = new Map(
    currentPositions.map((p) => [
      p.market,
      { side: p.side, size: new BigNumber(p.size.toString()) },
    ]),
  );

  return desiredPositions.map((dp) => {
    const current = positionMap.get(dp.extendedTicker);
    const currentSize = current?.size || new BigNumber(0);
    const currentSide = current?.side;

    let diff: { side: OrderSide; size: BigNumber };

    //TODO: Check logic
    if (!currentSide) {
      if (dp.desiredSize.gt(0)) {
        diff = { side: "BUY", size: dp.desiredSize };
      } else if (dp.desiredSize.lt(0)) {
        diff = { side: "SELL", size: dp.desiredSize.abs() };
      } else {
        diff = { side: "BUY", size: new BigNumber(0) };
      }
    } else if (currentSide === "LONG") {
      if (dp.desiredSize.gt(currentSize)) {
        diff = { side: "BUY", size: dp.desiredSize.minus(currentSize) };
      } else if (dp.desiredSize.lt(currentSize)) {
        diff = { side: "SELL", size: currentSize.minus(dp.desiredSize) };
      } else {
        diff = { side: "BUY", size: new BigNumber(0) };
      }
    } else {
      if (dp.desiredSize.abs().gt(currentSize)) {
        diff = { side: "SELL", size: dp.desiredSize.abs().minus(currentSize) };
      } else if (dp.desiredSize.abs().lt(currentSize)) {
        diff = { side: "BUY", size: currentSize.minus(dp.desiredSize.abs()) };
      } else {
        diff = { side: "BUY", size: new BigNumber(0) };
      }
    }

    return {
      extendedTicker: dp.extendedTicker,
      side: diff.side,
      size: diff.size,
    };
  });
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
