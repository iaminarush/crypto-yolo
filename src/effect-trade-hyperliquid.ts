import {
  type AllMidsResponse,
  ApiRequestError,
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
import { formatPrice, SymbolConverter } from "@nktkas/hyperliquid/utils";
import type { Handler } from "aws-lambda";
import BN from "bignumber.js";
import { Clock, Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { Resource } from "sst";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Database } from "../database.types";
import { getConfig, getTickers, getWeightsAndVolatilities } from "./api";
import { SLIPPAGE } from "./constants";
import { sendTelegramMessage } from "./util";

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

class TickerMappingError extends Schema.TaggedError<TickerMappingError>()("TickerMappingError", {
  ticker: Schema.String,
  message: Schema.String,
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

//TODO: fix effect lazy
class HyperliquidService extends Context.Service<
  HyperliquidService,
  {
    readonly wallet: Hex;
    readonly converter: SymbolConverter;
    readonly client: InfoClient;
    readonly exchange: ExchangeClient;

    readonly clearinghouseState: () => Effect.Effect<ClearinghouseStateResponse, HyperliquidError>;
    readonly spotClearinghouseState: () => Effect.Effect<
      SpotClearinghouseStateResponse,
      HyperliquidError
    >;
    readonly meta: () => Effect.Effect<MetaResponse, HyperliquidError>;
    readonly allMids: () => Effect.Effect<AllMidsResponse, HyperliquidError>;
    readonly l2Book: (coin: string) => Effect.Effect<L2BookResponse, HyperliquidError>;
    readonly openOrders: () => Effect.Effect<OpenOrdersResponse, HyperliquidError>;

    createLimitOrder(args: {
      ticker: string;
      size: BN;
      side: "BUY" | "SELL";
    }): Effect.Effect<
      OrderSuccessResponse | { status: "skipped"; reason: string },
      HyperliquidError | OrderError
    >;
    marketOrderRebalance(args: { desiredPositions: TDesiredPosition[] }): Effect.Effect<
      {
        ordered: Array<OrderSuccessResponse & { ticker: string }>;
        skipped: { status: "skipped"; ticker: string }[];
        failed: HyperliquidError[];
      },
      HyperliquidError
    >;
    cancelOrders: (orders: OpenOrdersResponse) => Effect.Effect<void, HyperliquidError, never>;
  }
>()("HyperliquidService") {
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
      });

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
      );

      const meta = Effect.fn("HyperliquidService.meta")(function* () {
        return yield* Effect.tryPromise({
          try: () => client.meta(),
          catch: (cause) => new HyperliquidError({ message: "Retreiving Meta Failed", cause }),
        });
      });

      const allMids = Effect.fn("HyperliquidService.allMids")(function* () {
        return yield* Effect.tryPromise({
          try: () => client.allMids(),
          catch: (cause) =>
            new HyperliquidError({
              message: "Retreiving All Mids Failed",
              cause,
            }),
        });
      });

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
      });

      const createLimitOrder = Effect.fn("Hyperliquid.createLimitOrder")(function* ({
        ticker,
        size,
        side,
      }: {
        ticker: string;
        size: BN;
        side: "BUY" | "SELL";
      }) {
        const isBuy = side === "BUY";
        const assetId = converter.getAssetId(ticker);
        const szDecimals = converter.getSzDecimals(ticker);

        if (assetId === undefined || szDecimals === undefined)
          return {
            status: "skipped",
            reason: "AssetId or szDecimals not found",
          } as const;

        const attempt = Effect.gen(function* () {
          const book = yield* l2Book(ticker);
          const price = book?.levels[isBuy ? 0 : 1]?.[0]?.px;
          if (!price) {
            return {
              status: "skipped",
              reason: "No bid/ask price found",
            } as const;
          }

          return yield* Effect.tryPromise({
            try: () =>
              exchange.order({
                orders: [
                  {
                    a: assetId,
                    b: isBuy,
                    p: formatPrice(price, szDecimals),
                    s: size.toNumber(),
                    r: false,
                    t: { limit: { tif: "Alo" } },
                  },
                ],
              }),
            catch: (cause) =>
              new OrderError({
                ticker,
                message: "Order placement failed",
                cause,
              }),
          });
        });

        const retryPolicy = Schedule.forever.pipe(
          Schedule.addDelay(() => Effect.succeed("2000 millis")),
          Schedule.jittered,
        );

        return yield* attempt.pipe(Effect.retry(retryPolicy));
      });

      const marketOrderRebalance = Effect.fn("Hyperliquid.marketOrderRebalance")(function* ({
        desiredPositions,
      }: {
        desiredPositions: TDesiredPosition[];
      }) {
        const { assetPositions: currentPositions } = yield* clearinghouseState();

        const tickersToMarketOrder = [
          ...filterTickersToRebalance(desiredPositions, currentPositions).values(),
        ];

        const [failed, ordered] = yield* Effect.partition(tickersToMarketOrder, (desiredPosition) =>
          Effect.gen(function* () {
            const ticker = desiredPosition.exchangeTicker;
            const mids = yield* allMids();
            const currentPosition = currentPositions.find((p) => p.position.coin === ticker);
            const { size, side } = calculateOrderSize(
              desiredPosition,
              BN(currentPosition ? currentPosition.position.szi : 0),
              mids,
            );
            if (!size.gt(0)) return { ticker, status: "skipped" as const };
            const mid = mids[ticker];
            const price = parseFloat(mid) * (1 + (side === "BUY" ? SLIPPAGE : -SLIPPAGE));
            const response = yield* Effect.tryPromise({
              try: () =>
                exchange.order({
                  orders: [
                    {
                      a: converter.getAssetId(ticker) || "",
                      b: side === "BUY",
                      p: formatPrice(price, converter.getSzDecimals(ticker) || 0),
                      s: size.toNumber(),
                      r: false,
                      t: { limit: { tif: "Ioc" } },
                    },
                  ],
                }),
              catch: (cause) =>
                new HyperliquidError({ message: `Market order failed for ${ticker}`, cause }),
            });
            return { ...response, ticker };
          }),
        );
        return {
          failed,
          ordered: ordered.filter((o) => o.status !== "skipped"),
          skipped: ordered.filter((o) => o.status === "skipped"),
        };
      });

      const cancelOrders = Effect.fn("HyperliquidService.cancelOrders")(function* (
        orders: OpenOrdersResponse,
      ) {
        const cancels = orders.map((o) => ({ a: converter.getAssetId(o.coin) || "", o: o.oid }));

        yield* Effect.tryPromise({
          try: () =>
            exchange.cancel({ cancels }).catch((cause) => {
              if (cause instanceof ApiRequestError) return;
              throw cause;
            }),
          catch: (cause) => new HyperliquidError({ message: "Cancel request failed", cause }),
        });
      });

      return HyperliquidService.of({
        wallet: WALLET,
        converter,
        client,
        exchange,
        clearinghouseState,
        spotClearinghouseState,
        meta,
        allMids,
        l2Book,
        openOrders,
        createLimitOrder,
        marketOrderRebalance,
        cancelOrders,
      });
    }),
  );
}

class TelegramService extends Context.Service<
  TelegramService,
  {
    send(message: string): Effect.Effect<void, TelegramError>;
  }
>()("crypto-yolo/TelegramService") {
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
    readonly getConfig: Effect.Effect<TConfig, ConfigError>;
    readonly getTickers: Effect.Effect<TTicker[], ConfigError>;
    readonly getWeightsAndVolatilities: (
      config: TConfig,
    ) => Effect.Effect<WeightedTicker[], ConfigError>;
  }
>()("Hyperliquid/MarketDataService") {
  static readonly layer = Layer.effect(
    TradingConfigService,
    Effect.gen(function* () {
      const getConfig_ = Effect.fn("MarketDataService.getConfig")(function* () {
        return yield* Effect.tryPromise({
          try: () => getConfig("hyperliquid"),
          catch: (cause) => new ConfigError({ message: "Retrieving config failed", cause }),
        });
      });

      const getTickers_ = Effect.fn("MarketDataService.getTickers")(function* () {
        return yield* Effect.tryPromise({
          try: () => getTickers(),
          catch: (cause) => new ConfigError({ message: "Retrieving tickers failed", cause }),
        });
      });

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
        getConfig: getConfig_(),
        getTickers: getTickers_(),
        getWeightsAndVolatilities: getWeightsAndVolatilities_,
      });
    }),
  );
}

type TDesiredPosition = Effect.Success<ReturnType<typeof calculateDesiredPositions>>[number];

const calculateDesiredPositions = Effect.fn(function* (
  volAndWeight: WeightedTicker[],
  tickers: TTicker[],
  config: TConfig,
  markets: MetaResponse["universe"],
) {
  const tickerMap = new Map(
    tickers
      .filter((t) => markets.some((m) => m.name === t.hyperliquid_ticker))
      .map((t) => [t.rbw_ticker, t.hyperliquid_ticker]),
  );

  return yield* Effect.forEach(volAndWeight, (vw) =>
    Effect.gen(function* () {
      const exchangeTicker = tickerMap.get(vw.ticker);
      if (!exchangeTicker)
        return yield* new TickerMappingError({
          ticker: vw.ticker,
          message: `No hyperliquid ticker for ${vw.ticker}`,
        });

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
    }),
  );
});

const filterTickersToRebalance = (
  desiredPositions: readonly TDesiredPosition[],
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
  const startTime = yield* Clock.currentTimeMillis;
  const hl = yield* HyperliquidService;
  const tradingConfig = yield* TradingConfigService;
  const telegram = yield* TelegramService;

  const config = yield* tradingConfig.getConfig;
  const volAndWeight = yield* tradingConfig.getWeightsAndVolatilities(config);
  const tickers = yield* tradingConfig.getTickers;
  const { assetPositions } = yield* hl.clearinghouseState();
  const meta = yield* hl.meta();

  const desiredPositions = yield* calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    meta.universe,
  );
  const tickersToRebalance = filterTickersToRebalance(desiredPositions, assetPositions);

  const rebalancePass = Effect.gen(function* () {
    const allMids = yield* hl.allMids();

    const orders = yield* hl.openOrders();
    const { assetPositions: updatedPositions } = yield* hl.clearinghouseState();

    for (const [ticker, desiredPosition] of tickersToRebalance) {
      const order = orders.find((o) => o.coin === ticker);

      if (!order) {
        const currentPosition = updatedPositions.find((p) => p.position.coin === ticker);
        const { size, side } = calculateOrderSize(
          desiredPosition,
          BN(currentPosition ? currentPosition.position.szi : 0),
          allMids,
        );

        if (size.gt(0)) {
          yield* hl.createLimitOrder({ ticker, size, side });
        } else {
          tickersToRebalance.delete(ticker);
        }
      } else {
        const book = yield* hl.l2Book(ticker);
        const bestPrice = book?.levels[order.side === "B" ? 0 : 1]?.[0].px;

        if (bestPrice && BN(order.limitPx).eq(bestPrice)) continue;

        yield* hl.cancelOrders([order]);

        const currentPosition = updatedPositions.find((p) => p.position.coin === ticker);

        const { size, side } = calculateOrderSize(
          desiredPosition,
          currentPosition ? BN(currentPosition.position.szi) : BN(0),
          allMids,
        );

        if (size.gt(0)) {
          yield* hl.createLimitOrder({
            ticker,
            size,
            side,
          });
        } else {
          tickersToRebalance.delete(ticker);
        }
      }
    }
  });

  yield* rebalancePass.pipe(
    Effect.repeat(
      Schedule.spaced(Duration.millis(SLEEP_MS)).pipe(
        Schedule.while(({ elapsed }) => tickersToRebalance.size > 0 && elapsed <= MAX_RUNTIME_MS),
      ),
    ),
  );

  const openOrders = yield* hl.openOrders();
  yield* hl.cancelOrders(openOrders);
  const { ordered, failed } = yield* hl.marketOrderRebalance({ desiredPositions });

  const { assetPositions: finalPositions, crossMarginSummary } = yield* hl.clearinghouseState();
  const mids = yield* hl.allMids();

  const tickersOutOfBuffer = Array.from(
    filterTickersToRebalance(desiredPositions, finalPositions).values(),
  ).map((fr) => {
    const position = finalPositions.find((fp) => fp.position.coin === fr.exchangeTicker)?.position;

    const size = BN(position?.szi || 0);
    const midPrice = mids[fr.exchangeTicker];

    const gapToLower = size.minus(fr.lowerBound).abs();
    const gapToUpper = fr.upperBound.minus(size).abs();
    const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
    const priceGap = gap.times(midPrice).toNumber();

    return { ...fr, size, priceGap };
  });

  const runtimeMs = (yield* Clock.currentTimeMillis) - startTime;
  const minutes = Math.floor(runtimeMs / 60000);
  const seconds = Math.floor((runtimeMs % 60000) / 1000);

  const status =
    tickersToRebalance.size === 0
      ? "Maker on all orders"
      : failed.length > 0
        ? "Incomplete"
        : `${ordered.length} taker orders`;
  const marketedList = ordered.length > 0 ? ordered.map((o) => o.ticker).join(", ") : "None";
  const outOfBoundsList =
    tickersOutOfBuffer.length > 0
      ? tickersOutOfBuffer.map((t) => `${t.rwTicker} $${t.priceGap.toFixed(2)}`).join(", ")
      : "None";
  const { balances } = yield* hl.spotClearinghouseState();
  const usdcTotal = balances.find((b) => b.coin === "USDC")?.total || 1;
  const leverage = BN(crossMarginSummary.totalNtlPos)
    .dividedBy(usdcTotal)
    .decimalPlaces(2, BN.ROUND_HALF_UP);

  const message = `
  Hyperliquid Trading Complete

  ${status}
  Runtime: ${minutes}m ${seconds}s
  Market Order list: ${marketedList}
  Positions Out of Bounds: ${outOfBoundsList}
  Leverage: ${leverage}`;

  yield* telegram.send(message);

  return { finalPositions, tickersOutOfBuffer };
});

export const handler: Handler = () => Effect.runPromise(program.pipe(Effect.provide(AppLayer)));
