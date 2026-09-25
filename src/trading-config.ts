import { createClient } from "@supabase/supabase-js";
import BN from "bignumber.js";
import type { Database } from "../database.types";
import { BigDecimal, Config, Context, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { Resource } from "sst";
import { SUPABASE_URL } from "./constants";

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

class AllocationError extends Schema.TaggedError<AllocationError>()("AllocationError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];
type TTicker = Database["public"]["Tables"]["ticker"]["Row"];
type TExchangeNames = "extended" | "hyperliquid" | "risex";

export type Weight = {
  ticker: string;
  arrival_price: number;
  carry_megafactor: number;
  combo_weight: number;
  momentum_megafactor: number;
  trend_megafactor: number;
};

export type Volatility = {
  ticker: string;
  ewvol: number;
  date: string;
};

export type WeightedTicker = {
  ticker: string;
  token_allocation: BN;
};

const retryPolicy = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
);

/**
 * Pure allocation math — no I/O. Takes fetched weights + volatilities and the
 * exchange config, returns vol-scaled dollar allocations per ticker.
 * TODO: port the body of getWeightsAndVolatilities from src/api.ts.
 */
export const computeAllocations = (
  _weights: Weight[],
  _volatilities: Volatility[],
  _config: TConfig,
): Effect.Effect<WeightedTicker[], AllocationError> =>
  Effect.die("TODO: implement computeAllocations");

const ONE = BigDecimal.fromBigInt(1n);
const WEIGHT_TOLERANCE = BigDecimal.fromStringUnsafe("0.000000001");

const supabase = createClient<Database>(SUPABASE_URL, Resource.SUPABASE_KEY.value);

export const getConfig = Effect.fn("TradingConfigService.getConfig")(function* (
  exchange: TExchangeNames,
) {
  const data = yield* Effect.tryPromise({
    try: () => supabase.from("exchange").select().eq("exchange", exchange).single(),
    catch: (cause) => new ConfigError({ message: `Selecting ${exchange} config failed`, cause }),
  }).pipe(
    Effect.retry(retryPolicy),
    Effect.map((response) => response.data),
    Effect.filterOrFail(
      Predicate.isNotNullish,
      (cause) => new ConfigError({ message: `Null ${exchange} config`, cause }),
    ),
    Effect.filterOrFail(
      (data) => {
        const sum = BigDecimal.sumAll([
          BigDecimal.fromNumberUnsafe(data.trend_weight),
          BigDecimal.fromNumberUnsafe(data.momentum_weight),
          BigDecimal.fromNumberUnsafe(data.carry_weight),
        ]);

        return BigDecimal.isLessThanOrEqualTo(
          BigDecimal.abs(BigDecimal.subtract(sum, ONE)),
          WEIGHT_TOLERANCE,
        );
      },
      (cause) =>
        new ConfigError({ message: `${exchange} config weights didn't add up to 1`, cause }),
    ),
  );

  return data;
});

export const getTickers = Effect.tryPromise({
  try: () => supabase.from("ticker").select().throwOnError(),
  catch: (cause) => new ConfigError({ message: "Getting tickers failed", cause }),
}).pipe(
  Effect.retry(retryPolicy),
  Effect.map((response) => response.data),
);
