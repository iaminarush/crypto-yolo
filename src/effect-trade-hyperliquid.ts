import { ExchangeClient, HttpTransport, InfoClient, type MetaResponse } from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import type { Handler } from "aws-lambda";
import BN from "bignumber.js";
import type { Database } from "database.types";
import { Context, Effect, Layer, Schema } from "effect";
import { Resource } from "sst";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { getConfig, getTickers, getWeightsAndVolatilities } from "./api";

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

class TickerMappingError extends Schema.TaggedError<TickerMappingError>()("TickerMappingError", {
  ticker: Schema.String,
}) {}

class OrderError extends Schema.TaggedError<OrderError>()("OrderError", {
  ticker: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

class HyperliquidService extends Context.Service<
  HyperliquidService,
  {
    readonly infoClient: InfoClient;
    readonly exchangeClient: ExchangeClient;
    readonly converter: SymbolConverter;
    readonly wallet: Hex;
  }
>()("HyperliquidService") {
  static readonly layer = Layer.effect(
    HyperliquidService,
    Effect.gen(function* () {
      const WALLET = Resource.HYPERLIQUID_WALLET.value as Hex;
      const wallet = privateKeyToAccount(Resource.HYPERLIQUID_KEY.value as Hex);
      const transport = new HttpTransport();

      const converter = yield* Effect.tryPromise(() => SymbolConverter.create({ transport }));

      return HyperliquidService.of({
        infoClient: new InfoClient({ transport }),
        exchangeClient: new ExchangeClient({ transport, wallet }),
        converter,
        wallet: WALLET,
      });
    }),
  );
}

type Config = Awaited<ReturnType<typeof getConfig>>;

class ConfigService extends Context.Service<
  ConfigService,
  {
    readonly getConfig: (exchange: string) => Effect.Effect<Config, ConfigError>;
    readonly getTickers: () => Effect.Effect<Awaited<ReturnType<typeof getTickers>>, ConfigError>;
    readonly getWeightsAndVol: (
      config: Config,
    ) => Effect.Effect<Awaited<ReturnType<typeof getWeightsAndVolatilities>>, ConfigError>;
  }
>()("ConfigService") {}
