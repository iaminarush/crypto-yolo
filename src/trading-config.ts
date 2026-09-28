import { createClient } from "@supabase/supabase-js";
import BN from "bignumber.js";
import type { Database } from "../database.types";
import {
  BigDecimal,
  Config,
  Context,
  Effect,
  flow,
  Layer,
  pipe,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { Resource } from "sst";
import { ROBOTWEALTH_API, SUPABASE_URL } from "./constants";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

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

const ONE = BigDecimal.fromBigInt(1n);
const WEIGHT_TOLERANCE = BigDecimal.fromStringUnsafe("0.000000001");

const supabase = createClient<Database>(SUPABASE_URL, Resource.SUPABASE_KEY.value);

export const getConfig = Effect.fn("TradingConfigService.getConfig")(function* (
  exchange: TExchangeNames,
) {
  const data = yield* Effect.tryPromise({
    try: () => supabase.from("exchange").select().eq("exchange", exchange).single().throwOnError(),
    catch: (cause) => new ConfigError({ message: `Selecting ${exchange} config failed`, cause }),
  }).pipe(
    Effect.map((response) => response.data),
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
}).pipe(Effect.map((response) => response.data));

const robotWealthClient = Effect.gen(function* () {
  return (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl(ROBOTWEALTH_API),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setUrlParam("api_key", Resource.ROBOTWEALTH_KEY.value),
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
      times: 4,
    }),
  );
});

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));

const Weight = Schema.Struct({
  ticker: Schema.String,
  arrival_price: Schema.Finite,
  carry_megafactor: Schema.Finite,
  combo_weight: Schema.Finite,
  momentum_megafactor: Schema.Finite,
  trend_megafactor: Schema.Finite,
});

const WeightsSchema = Schema.Struct({
  success: Schema.Literal(true),
  last_updated: Schema.Finite,
  data: Schema.NonEmptyArray(Weight),
});

const getWeights = Effect.fn("TradingConfigService.getWeights")(function* () {
  const client = yield* robotWealthClient;

  return yield* client.get("/weights").pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(WeightsSchema)),
    Effect.mapError((cause) =>
      Schema.isSchemaError(cause)
        ? new ConfigError({ message: `Weights payload invalid: ${cause.message}`, cause })
        : new ConfigError({ message: "Fetching weights failed", cause }),
    ),
  );
});

const VolSchema = Schema.Struct({
  data: Schema.NonEmptyArray(
    Schema.Struct({
      date: Schema.String,
      ewvol: Positive,
      ticker: Schema.String,
    }),
  ),
  last_updated: Schema.Finite,
  success: Schema.Literal(true),
});

const getVolatilities = Effect.fn("TradingConfigService.getVolatilities")(function* () {
  const client = yield* robotWealthClient;

  return yield* client.get("/volatilities").pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(VolSchema)),
    Effect.mapError((cause) =>
      Schema.isSchemaError(cause)
        ? new ConfigError({ message: `Volatility payload invalid: ${cause.message}`, cause })
        : new ConfigError({ message: "Fetching volatility failed", cause }),
    ),
  );
});

const getVolScaledWeights = Effect.fn("TradingConfigService.getWeightsAndVolatilities")(
  function* () {
    const weights = yield* getWeights();
    const volatilities = yield* getVolatilities();
    let totalVol = BigDecimal.fromBigInt(0n);
    const volByTicker = new Map(volatilities.data.map((v) => [v.ticker, v]));
    const dec = BigDecimal.fromNumberUnsafe;

    const merged = yield* Effect.forEach(weights, (w) =>
      Effect.gen(function* () {
        const vol = volByTicker.get(w.ticker);
        if (vol === undefined)
          return yield* new ConfigError({ message: `No volatility for ${w.ticker}`, cause: w });
      }),
    );
  },
);
