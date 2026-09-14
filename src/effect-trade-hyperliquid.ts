import {
  type AllMidsResponse,
  type CancelSuccessResponse,
  type ClearinghouseStateResponse,
  ExchangeClient,
  HttpTransport,
  InfoClient,
  type L2BookResponse,
  type MetaResponse,
  type OpenOrdersResponse,
  type OrderSuccessResponse,
  type SpotClearinghouseStateResponse,
} from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import type { Handler } from "aws-lambda";
import BN from "bignumber.js";
import type { Database } from "database.types";
import { Context, Effect, Layer, Schema } from "effect";
import { Resource } from "sst";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig, getTickers, getWeightsAndVolatilities } from "./api";
import { createLimitOrder } from "./hyperliquid/create-limit-order";
import { sendTelegramMessage } from "./util";

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

class TickerMappingError extends Schema.TaggedError<TickerMappingError>()("TickerMappingError", {
  ticker: Schema.String,
  message: Schema.Defect(),
}) {}

class OrderError extends Schema.TaggedError<OrderError>()("OrderError", {
  ticker: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

class HyperliquidError extends Schema.TaggedError<HyperliquidError>()("HyperliquidError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const SLEEP_MS = 2250;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const MINIMUM_ORDER_VALUE = BN(10);

class HyperliquidService extends Context.Service<
  HyperliquidService,
  {
    readonly wallet: Hex;
    readonly converter: SymbolConverter;

    readonly clearinghouseState: Effect.Effect<ClearinghouseStateResponse, HyperliquidError>;
    readonly spotClearinghouseState: Effect.Effect<
      SpotClearinghouseStateResponse,
      HyperliquidError
    >;
    readonly meta: Effect.Effect<MetaResponse, HyperliquidError>;
    readonly allMids: Effect.Effect<AllMidsResponse, HyperliquidError>;
    l2Book(coin: string): Effect.Effect<L2BookResponse, HyperliquidError>;
    readonly openOrders: Effect.Effect<OpenOrdersResponse, HyperliquidError>;

    // placeLimitOrder(args: {
    //   ticker: string;
    //   size: BN;
    //   side: "BUY" | "SELL";
    // }): Effect.Effect<OrderSuccessResponse, OrderError>;
    // placeMarketOrder(args: {
    //   ticker: string;
    //   size: BN;
    //   side: "BUY" | "SELL";
    // }): Effect.Effect<OrderSuccessResponse, OrderError>;
    // cancelOrders(
    //   cancels: { ticker: string; oid: number }[],
    // ): Effect.Effect<CancelSuccessResponse, OrderError>;
  }
>()("extended-yolo/HyperliquidService") {
  static readonly layer = Layer.effect(
    HyperliquidService,
    Effect.gen(function* () {
      const WALLET = Resource.HYPERLIQUID_WALLET.value as Hex;
      const transport = new HttpTransport();
      const client = new InfoClient({ transport });
      const wallet = yield* Effect.try({
        try: () => privateKeyToAccount(Resource.HYPERLIQUID_KEY.value as Hex),
        catch: (cause) =>
          new HyperliquidError({
            message: "Walllet initialization failed",
            cause,
          }),
      });
      const converter = yield* Effect.tryPromise({
        try: () => SymbolConverter.create({ transport }),
        catch: (cause) =>
          new HyperliquidError({
            message: "SymbolConverter initialization failed",
            cause,
          }),
      });

      const exchange = new ExchangeClient({ transport, wallet });

      const clearinghouseState = Effect.fn("HyperliquidService.clearinghouseState")(function* () {
        return yield* Effect.tryPromise({
          try: () => client.clearinghouseState({ user: WALLET }),
          catch: (cause) =>
            new HyperliquidError({
              message: "Retreiving Perp Positions Failed",
              cause,
            }),
        });
      })();

      const spotClearinghouseState = Effect.fn("HyperliquidService.spotClearinghouseState")(
        function* () {
          return yield* Effect.tryPromise({
            try: () => client.spotClearinghouseState({ user: WALLET }),
            catch: (cause) =>
              new HyperliquidError({
                message: "Retreiving Spot Positions Failed",
                cause,
              }),
          });
        },
      )();

      const meta = Effect.fn("HyperliquidService.meta")(function* () {
        return yield* Effect.tryPromise({
          try: () => client.meta(),
          catch: (cause) => new HyperliquidError({ message: "Retreiving Meta Failed", cause }),
        });
      })();

      const allMids = Effect.fn("HyperliquidService.allMids")(function* () {
        return yield* Effect.tryPromise({
          try: () => client.allMids(),
          catch: (cause) =>
            new HyperliquidError({
              message: "Retreiving All Mids Failed",
              cause,
            }),
        });
      })();

      const l2Book = Effect.fn("HyperliquidService.l2Book")(function* (coin: string) {
        return yield* Effect.tryPromise({
          try: () => client.l2Book({ coin }),
          catch: (cause) =>
            new HyperliquidError({
              message: "Retreiving l2Book failed",
              cause,
            }),
        });
      });

      const openOrders = Effect.fn("HyperliquidService.openOrders")(function* () {
        return yield* Effect.tryPromise({
          try: () => client.openOrders({ user: WALLET }),
          catch: (cause) =>
            new HyperliquidError({
              message: "Retreiving Open Orders failed",
              cause,
            }),
        });
      })();

      return HyperliquidService.of({
        wallet: WALLET,
        converter,
        clearinghouseState,
        spotClearinghouseState,
        meta,
        allMids,
        l2Book,
        openOrders,
      });
    }),
  );
}

class TelegramService extends Context.Service<
  TelegramService,
  {
    send(message: string): Effect.Effect<void, TelegramError>;
  }
>()("extended-yolo/TelegramService") {
  static readonly layer = Layer.effect(
    TelegramService,
    Effect.gen(function* () {
      const send = Effect.fn("TelegramService.send")(function* (message: string) {
        yield* Effect.tryPromise({
          try: () => sendTelegramMessage(message),
          catch: (cause) => new TelegramError({ message: "Telegram send failed", cause }),
        });
      });
      return TelegramService.of({ send });
    }),
  );
}

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];
type TTicker = Database["public"]["Tables"]["ticker"]["Row"];

export type WeightedTicker = {
  ticker: string;
  token_allocation: BN;
};

class TradingConfigService extends Context.Service<
  TradingConfigService,
  {
    getConfig: Effect.Effect<TConfig, ConfigError>;
    getTickers: Effect.Effect<TTicker[], ConfigError>;
    getWeightsAndVolatilities(config: TConfig): Effect.Effect<WeightedTicker[], ConfigError>;
  }
>()("extended-yolo/MarketDataService") {
  static readonly layer = Layer.effect(
    TradingConfigService,
    Effect.gen(function* () {
      const getConfig_ = Effect.fn("MarketDataService.getConfig")(function* () {
        return yield* Effect.tryPromise({
          try: () => getConfig("hyperliquid"),
          catch: (cause) => new ConfigError({ message: "Retrieving config failed", cause }),
        });
      })();

      const getTickers_ = Effect.fn("MarketDataService.getTickers")(function* () {
        return yield* Effect.tryPromise({
          try: () => getTickers(),
          catch: (cause) => new ConfigError({ message: "Retrieving tickers failed", cause }),
        });
      })();

      const getWeightsAndVolatilities_ = Effect.fn("MarketDataService.getWeightsAndVolatilities")(
        function* (config: TConfig) {
          return yield* Effect.tryPromise({
            try: () => getWeightsAndVolatilities(config),
            catch: (cause) =>
              new ConfigError({
                message: "Retrieving weights and vols failed",
                cause,
              }),
          });
        },
      );

      return TradingConfigService.of({
        getConfig: getConfig_,
        getTickers: getTickers_,
        getWeightsAndVolatilities: getWeightsAndVolatilities_,
      });
    }),
  );
}

const calculateDesiredPositions = (
  volAndWeight: WeightedTicker[],
  tickers: TTicker[],
  config: TConfig,
  markets: MetaResponse["universe"],
) => {
  const tickerMap = new Map(
    tickers
      .filter((t) => markets.some((m) => m.name === t.hyperliquid_ticker))
      .map((t) => [t.rbw_ticker, t.hyperliquid_ticker]),
  );

  return volAndWeight.map((vw) => {
    const exchangeTicker = tickerMap.get(vw.ticker);
    if (!exchangeTicker) throw new Error(`No hyperliquid ticker for ${vw.ticker}`);

    const tokenAllocation = vw.token_allocation;

    const isPositive = tokenAllocation.gte(0);

    const market = markets.find((m) => m.name === exchangeTicker);

    return {
      rwTicker: vw.ticker,
      exchangeTicker,
      desiredSize: tokenAllocation,
      upperBound: tokenAllocation.times(
        BN(isPositive ? config.trade_buffer : -config.trade_buffer).plus(1),
      ),
      lowerBound: tokenAllocation.times(
        BN(isPositive ? -config.trade_buffer : config.trade_buffer).plus(1),
      ),
      minOrderSizeChange: market ? getMinOrderSizeChange(market.szDecimals) : BN(0),
      szDecimals: market ? market.szDecimals : 1,
    };
  });
};

type TDesiredPosition = ReturnType<typeof calculateDesiredPositions>[number];

const filterTickersToRebalance = (
  desiredPositions: TDesiredPosition[],
  currentPositions: ClearinghouseStateResponse["assetPositions"],
) => {
  const positionMap = new Map(currentPositions.map((p) => [p.position.coin, BN(p.position.szi)]));

  const result = new Map<string, TDesiredPosition>();

  for (const dp of desiredPositions) {
    const currentSize = positionMap.get(dp.exchangeTicker);

    if (currentSize === undefined) {
      result.set(dp.exchangeTicker, dp);
      continue;
    }

    if (currentSize.gte(dp.lowerBound) && currentSize.lte(dp.upperBound)) {
      continue;
    }

    result.set(dp.exchangeTicker, dp);
  }
  return result;
};

function calculateOrderSize(
  desiredPosition: TDesiredPosition,
  currentPosition: BN,
  allMids: AllMidsResponse,
): { size: BN; side: "BUY" | "SELL" } {
  const { szDecimals, lowerBound, upperBound } = desiredPosition;
  const midPrice = allMids[desiredPosition.exchangeTicker];
  const minOrdersize = MINIMUM_ORDER_VALUE.div(midPrice).decimalPlaces(szDecimals, BN.ROUND_UP);

  if (currentPosition.gte(lowerBound) && currentPosition.lte(upperBound)) {
    return { size: BN(0), side: "BUY" };
  }
  if (currentPosition.lt(lowerBound)) {
    const gap = lowerBound.minus(currentPosition);

    const size = gap.lt(minOrdersize) ? minOrdersize : gap;

    const roundedUp = roundToDecimal(size, szDecimals, BN.ROUND_UP);
    const roundedDown = roundToDecimal(size, szDecimals, BN.ROUND_DOWN);

    if (currentPosition.plus(roundedUp).lt(desiredPosition.upperBound))
      return { size: roundedUp, side: "BUY" };

    if (currentPosition.plus(roundedDown).lt(desiredPosition.upperBound))
      return { size: roundedDown, side: "BUY" };

    return { size: BN(0), side: "BUY" };
  }

  if (currentPosition.gt(desiredPosition.upperBound)) {
    const gap = desiredPosition.upperBound.minus(currentPosition).absoluteValue();

    const size = gap.lt(minOrdersize) ? minOrdersize : gap;

    const roundedUp = roundToDecimal(size, szDecimals, BN.ROUND_UP);
    const roundedDown = roundToDecimal(size, szDecimals, BN.ROUND_DOWN);

    if (currentPosition.plus(roundedUp).gt(desiredPosition.lowerBound))
      return { size: roundedUp, side: "SELL" };

    if (currentPosition.plus(roundedDown).gt(desiredPosition.lowerBound))
      return { size: roundedDown, side: "SELL" };

    return { size: BN(0), side: "SELL" };
  }

  return { size: BN(0), side: "BUY" };
}

function getMinOrderSizeChange(szDecimals: number): BN {
  return new BN(1).dividedBy(new BN(10).pow(szDecimals));
}

function roundToDecimal(value: BN, szDecimals: number, roundingMode?: BN.RoundingMode) {
  return value.decimalPlaces(szDecimals, roundingMode);
}

const AppLayer = Layer.mergeAll(
  HyperliquidService.layer,
  TradingConfigService.layer,
  TelegramService.layer,
);

const program = Effect.gen(function* () {
  const hl = yield* HyperliquidService;
  const tradingConfig = yield* TradingConfigService;
  const telegram = yield* TelegramService;

  const config = yield* tradingConfig.getConfig;
  const volAndWeight = yield* tradingConfig.getWeightsAndVolatilities(config);
  const tickers = yield* tradingConfig.getTickers;
});

export const handler: Handler = () => {};
