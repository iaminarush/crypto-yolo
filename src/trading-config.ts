import { createClient } from "@supabase/supabase-js";
import BN from "bignumber.js";
import type { Database } from "../database.types";
import { Config, Context, Effect, Layer, Predicate, Schedule, Schema } from "effect";
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

export class TradingConfigService extends Context.Service<
  TradingConfigService,
  {
    getConfig: (exchange: TExchangeNames) => Effect.Effect<TConfig, ConfigError>;
    readonly getTickers: Effect.Effect<TTicker[], ConfigError>;
    readonly getWeights: Effect.Effect<{ data: Weight[] }, ConfigError>;
    readonly getVolatilities: Effect.Effect<{ data: Volatility[] }, ConfigError>;
    readonly getWeightsAndVolatilities: (
      config: TConfig,
    ) => Effect.Effect<WeightedTicker[], ConfigError | AllocationError>;
  }
>()("TradingConfigService") {
  static readonly layer = Layer.effect(
    TradingConfigService,
    Effect.gen(function* () {
      const supabase = createClient<Database>(SUPABASE_URL, Resource.SUPABASE_KEY.value);

      // TODO: Effect translations of the src/api.ts fetches (supabase reads +
      // ROBOTWEALTH_API weights/volatilities via ky + fetchAndParse), each
      // wrapped in Effect.try + retryPolicy, errors mapped to ConfigError.
      const getConfig = Effect.fn("TradingConfigService.getConfig")(function* (
        exchange: TExchangeNames,
      ) {
        const data = yield* Effect.tryPromise({
          try: () => supabase.from("exchange").select().eq("exchange", exchange).single(),
          catch: (cause) =>
            new ConfigError({ message: `Selecting ${exchange} config failed`, cause }),
        }).pipe(
          Effect.map((response) => response.data),
          Effect.filterOrFail(
            Predicate.isNotNullish,
            (cause) => new ConfigError({ message: `Null ${exchange} config`, cause }),
          ),
        );
      });

      const getTickers = Effect.die("TODO: implement getTickers") as Effect.Effect<
        TTicker[],
        ConfigError
      >;

      const getWeights = Effect.die("TODO: implement getWeights") as Effect.Effect<
        { data: Weight[] },
        ConfigError
      >;

      const getVolatilities = Effect.die("TODO: implement getVolatilities") as Effect.Effect<
        { data: Volatility[] },
        ConfigError
      >;

      const getWeightsAndVolatilities = Effect.fn("TradingConfigService.getWeightsAndVolatilities")(
        function* (config: TConfig) {
          const weights = yield* getWeights;
          const volatilities = yield* getVolatilities;
          return yield* computeAllocations(weights.data, volatilities.data, config);
        },
      );

      void supabase;

      return TradingConfigService.of({
        getConfig,
        getTickers,
        getWeights,
        getVolatilities,
        getWeightsAndVolatilities,
      });
    }),
  );
}
