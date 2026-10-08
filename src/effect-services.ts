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
import { ROBOTWEALTH_API, SUPABASE_URL, TELEGRAM_API } from "./constants";

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];
type TExchangeNames = "extended" | "hyperliquid" | "risex";

const ONE = BigDecimal.fromBigInt(1n);
const WEIGHT_TOLERANCE = BigDecimal.fromStringUnsafe("0.000000001");
const dec = BigDecimal.fromNumberUnsafe;

/** Raw trend megafactors are tiny next to demeaned momentum/carry, so scale them up by this before weighting by universe size. */
const TREND_SCALE = 10;

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

export type TWeight = Effect.Success<ReturnType<typeof getWeights>>["data"][number];

const getDemeanedVolScaledWeights = Effect.fn("TradingConfig.getDemeanedVolScaledWeights")(
  function* (config: TConfig, universe: Iterable<string>) {
    const { weights, volatilities } = yield* Effect.all(
      {
        weights: getWeights(),
        volatilities: getVolatilities(),
      },
      { concurrency: "unbounded" },
    );

    const universeSet = new Set(universe);
    const filteredWeights = weights.data.filter((w) => universeSet.has(w.ticker));

    if (filteredWeights.length === 0)
      return yield* new ConfigError({
        message: "Demeaned universe matched no weights",
        cause: [...universeSet],
      });

    const count = dec(filteredWeights.length);
    const momentums = filteredWeights.map((w) => dec(w.momentum_megafactor));
    const carries = filteredWeights.map((w) => dec(w.carry_megafactor));

    const averageMomentum = BigDecimal.divideUnsafe(BigDecimal.sumAll(momentums), count);
    const averageCarry = BigDecimal.divideUnsafe(BigDecimal.sumAll(carries), count);
    const absSumMomentum = BigDecimal.sumAll(momentums.map((n) => BigDecimal.abs(n)));
    const absSumCarry = BigDecimal.sumAll(carries.map((n) => BigDecimal.abs(n)));

    if (BigDecimal.isZero(absSumMomentum) || BigDecimal.isZero(absSumCarry))
      return yield* new ConfigError({
        message: "Demeaning requires a non-zero momentum and carry spread",
        cause: { absSumMomentum, absSumCarry },
      });

    const volByTicker = new Map(volatilities.data.map((v) => [v.ticker, v]));

    const missingVol = filteredWeights.filter((w) => !volByTicker.has(w.ticker));
    if (missingVol.length > 0)
      return yield* new ConfigError({
        message: `No volatility for ${missingVol.map((w) => w.ticker).join(", ")}`,
        cause: missingVol,
      });

    const merged = filteredWeights.map((w) => {
      const vol = volByTicker.get(w.ticker)!;

      const demeanedMomentum = BigDecimal.divideUnsafe(
        BigDecimal.subtract(dec(w.momentum_megafactor), averageMomentum),
        absSumMomentum,
      );
      const demeanedCarry = BigDecimal.divideUnsafe(
        BigDecimal.subtract(dec(w.carry_megafactor), averageCarry),
        absSumCarry,
      );
      const adjustedTrend = BigDecimal.divideUnsafe(
        BigDecimal.multiply(dec(w.trend_megafactor), dec(TREND_SCALE)),
        count,
      );
      const inverseVol = BigDecimal.divideUnsafe(ONE, dec(vol.ewvol));

      const comboWeight = BigDecimal.sumAll([
        BigDecimal.multiply(adjustedTrend, dec(config.trend_weight)),
        BigDecimal.multiply(demeanedMomentum, dec(config.momentum_weight)),
        BigDecimal.multiply(demeanedCarry, dec(config.carry_weight)),
      ]);

      return {
        ticker: w.ticker,
        arrivalPrice: dec(w.arrival_price),
        volScaledWeight: clampWeight(BigDecimal.multiply(inverseVol, comboWeight)),
      };
    });

    const totalVol = BigDecimal.sumAll(merged.map((m) => BigDecimal.abs(m.volScaledWeight)));
    const denominator = BigDecimal.isGreaterThan(totalVol, ONE) ? totalVol : ONE;

    return merged.map((m) => {
      const volScaledWeight = BigDecimal.divideUnsafe(m.volScaledWeight, denominator);
      const dollarAllocation = BigDecimal.multiply(volScaledWeight, dec(config.allocation));
      const tokenAllocation = BigDecimal.divideUnsafe(dollarAllocation, m.arrivalPrice);

      return { ticker: m.ticker, token_allocation: tokenAllocation };
    });
  },
  Effect.provide(FetchHttpClient.layer),
);

type TTicker = Database["public"]["Tables"]["ticker"]["Row"];

export class TradingConfigService extends Context.Service<
  TradingConfigService,
  {
    readonly getConfig: (exchange: TExchangeNames) => Effect.Effect<TConfig, ConfigError>;
    readonly getTickers: Effect.Effect<TTicker[], ConfigError>;
    readonly getWeights: Effect.Effect<ReadonlyArray<TWeight>, ConfigError>;
    readonly getVolScaledWeights: (config: TConfig) => Effect.Effect<WeightedTicker[], ConfigError>;
    readonly getDemeanedVolScaledWeights: (
      config: TConfig,
      universe: Iterable<string>,
    ) => Effect.Effect<WeightedTicker[], ConfigError>;
  }
>()("TradingConfigService") {
  static readonly layer = Layer.succeed(
    TradingConfigService,
    TradingConfigService.of({
      getConfig: (exchangeName) => getConfig(exchangeName).pipe(Effect.retry(promiseRetry)),
      getTickers: getTickers.pipe(Effect.retry(promiseRetry)),
      getWeights: getWeights().pipe(
        Effect.map((response) => response.data),
        Effect.provide(FetchHttpClient.layer),
        Effect.retry(promiseRetry),
      ),
      getVolScaledWeights: (config) => getVolScaledWeights(config),
      getDemeanedVolScaledWeights: (config, universe) =>
        getDemeanedVolScaledWeights(config, universe),
    }),
  );
}

class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const TELEGRAM_BASE_URL = `${TELEGRAM_API}/bot${Resource.TELEGRAM_TOKEN.value}`;

const telegramClient = Effect.gen(function* () {
  return (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl(TELEGRAM_BASE_URL), HttpClientRequest.acceptJson),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
      times: 4,
    }),
  );
});

const SendMessageSchema = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    message_id: Schema.Finite,
    text: Schema.String,
  }),
});

const sendTelegramMessage = Effect.fn("Telegram.sendTelegramMessage")(function* (message: string) {
  const client = yield* telegramClient;

  const request = yield* HttpClientRequest.post("/sendMessage").pipe(
    HttpClientRequest.bodyJson({
      chat_id: Resource.TELEGRAM_ID.value,
      text: message,
      parse_mode: "HTML",
    }),
    Effect.mapError(
      (cause) => new TelegramError({ message: "Encoding Telegram payload failed", cause }),
    ),
  );

  yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SendMessageSchema)),
    Effect.mapError((cause) =>
      Schema.isSchemaError(cause)
        ? new TelegramError({ message: `Telegram payload invalid: ${cause.message}`, cause })
        : new TelegramError({ message: "Telegram send failed", cause }),
    ),
  );
}, Effect.provide(FetchHttpClient.layer));

export class TelegramService extends Context.Service<
  TelegramService,
  {
    send(message: string): Effect.Effect<void, TelegramError>;
  }
>()("crypto-yolo/TelegramService") {
  static readonly layer = Layer.succeed(
    TelegramService,
    TelegramService.of({ send: sendTelegramMessage }),
  );
}
