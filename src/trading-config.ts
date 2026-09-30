import { createClient } from "@supabase/supabase-js";
import { BigDecimal, Context, Effect, flow, Layer, Schedule, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { Resource } from "sst";
import type { Database } from "../database.types";
import { ROBOTWEALTH_API, SUPABASE_URL } from "./constants";

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];
type TExchangeNames = "extended" | "hyperliquid" | "risex";

const ONE = BigDecimal.fromBigInt(1n);
const WEIGHT_TOLERANCE = BigDecimal.fromStringUnsafe("0.000000001");
const dec = BigDecimal.fromNumberUnsafe;

const promiseRetry = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
);

const supabase = createClient<Database>(SUPABASE_URL, Resource.SUPABASE_KEY.value);

const getConfig = Effect.fn("TradingConfig.getConfig")(function* (exchange: TExchangeNames) {
  const data = yield* Effect.tryPromise({
    try: () => supabase.from("exchange").select().eq("exchange", exchange).single().throwOnError(),
    catch: (cause) => new ConfigError({ message: `Selecting ${exchange} config failed`, cause }),
  }).pipe(
    Effect.map((response) => response.data),
    Effect.filterOrFail(
      (data) => {
        const sum = BigDecimal.sumAll([
          dec(data.trend_weight),
          dec(data.momentum_weight),
          dec(data.carry_weight),
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

const getTickers = Effect.tryPromise({
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
  arrival_price: Positive,
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

const getWeights = Effect.fn("TradingConfig.getWeights")(function* () {
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

const getVolatilities = Effect.fn("TradingConfig.getVolatilities")(function* () {
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

const clampWeight = BigDecimal.clamp({
  minimum: BigDecimal.fromStringUnsafe("-0.25"),
  maximum: BigDecimal.fromStringUnsafe("0.25"),
});

export type WeightedTicker = Effect.Success<ReturnType<typeof getVolScaledWeights>>[number];

const getVolScaledWeights = Effect.fn("TradingConfig.getVolScaledWeights")(function* (
  config: TConfig,
) {
  const { weights, volatilities } = yield* Effect.all(
    {
      weights: getWeights(),
      volatilities: getVolatilities(),
    },
    { concurrency: "unbounded" },
  );
  const volByTicker = new Map(volatilities.data.map((v) => [v.ticker, v]));

  const merged = yield* Effect.forEach(weights.data, (w) =>
    Effect.gen(function* () {
      const vol = volByTicker.get(w.ticker);
      if (vol === undefined)
        return yield* new ConfigError({ message: `No volatility for ${w.ticker}`, cause: w });
      const inverseVol = BigDecimal.divideUnsafe(ONE, dec(vol.ewvol));

      const comboWeight = BigDecimal.sumAll([
        BigDecimal.multiply(dec(w.trend_megafactor), dec(config.trend_weight)),
        BigDecimal.multiply(dec(w.momentum_megafactor), dec(config.momentum_weight)),
        BigDecimal.multiply(dec(w.carry_megafactor), dec(config.carry_weight)),
      ]);
      return {
        ticker: w.ticker,
        arrivalPrice: dec(w.arrival_price),
        volScaledWeight: clampWeight(BigDecimal.multiply(inverseVol, comboWeight)),
      };
    }),
  );

  const totalVol = BigDecimal.sumAll(merged.map((m) => BigDecimal.abs(m.volScaledWeight)));
  const denominator = BigDecimal.isGreaterThan(totalVol, ONE) ? totalVol : ONE;

  return merged.map((m) => {
    const volScaledWeight = BigDecimal.divideUnsafe(m.volScaledWeight, denominator);
    const dollarAllocation = BigDecimal.multiply(volScaledWeight, dec(config.allocation));
    const tokenAllocation = BigDecimal.divideUnsafe(dollarAllocation, m.arrivalPrice);

    return { ticker: m.ticker, token_allocation: tokenAllocation };
  });
}, Effect.provide(FetchHttpClient.layer));

type TTicker = Database["public"]["Tables"]["ticker"]["Row"];

export class TradingConfigService extends Context.Service<
  TradingConfigService,
  {
    readonly getConfig: (exchange: TExchangeNames) => Effect.Effect<TConfig, ConfigError>;
    readonly getTickers: Effect.Effect<TTicker[], ConfigError>;
    readonly getVolScaledWeights: (config: TConfig) => Effect.Effect<WeightedTicker[], ConfigError>;
  }
>()("TradingConfigService") {
  static readonly layer = Layer.succeed(
    TradingConfigService,
    TradingConfigService.of({
      getConfig: (exchangeName) => getConfig(exchangeName).pipe(Effect.retry(promiseRetry)),
      getTickers: getTickers.pipe(Effect.retry(promiseRetry)),
      getVolScaledWeights: (config) => getVolScaledWeights(config).pipe(Effect.retry(promiseRetry)),
    }),
  );
}
