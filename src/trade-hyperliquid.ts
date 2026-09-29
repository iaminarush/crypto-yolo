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
import {
  BigDecimal,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { Resource } from "sst";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Database } from "../database.types";
import { SLIPPAGE } from "./constants";
import { sendTelegramMessage } from "./util";
import { getConfig, getTickers, getVolScaledWeights, WeightedTicker } from "./trading-config";

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
const ZERO = BigDecimal.fromBigInt(0n);
const ONE = BigDecimal.fromBigInt(1n);
const dec = BigDecimal.fromNumberUnsafe;
const MINIMUM_ORDER_VALUE = dec(10);

const promiseRetry = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
);

class HyperliquidService extends Context.Service<
  HyperliquidService,
  {
    readonly wallet: Hex;
    readonly converter: SymbolConverter;
    readonly client: InfoClient;
    readonly exchange: ExchangeClient;

    readonly clearinghouseState: Effect.Effect<ClearinghouseStateResponse, HyperliquidError>;
    readonly spotClearinghouseState: Effect.Effect<
      SpotClearinghouseStateResponse,
      HyperliquidError
    >;
    readonly meta: Effect.Effect<MetaResponse, HyperliquidError>;
    readonly allMids: Effect.Effect<AllMidsResponse, HyperliquidError>;
    readonly l2Book: (coin: string) => Effect.Effect<L2BookResponse, HyperliquidError>;
    readonly openOrders: Effect.Effect<OpenOrdersResponse, HyperliquidError>;

    createLimitOrder(args: {
      ticker: string;
      size: BigDecimal.BigDecimal;
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
      }).pipe(Effect.retry(promiseRetry));

      const exchange = new ExchangeClient({ transport, wallet });

      const clearinghouseState = Effect.tryPromise({
        try: () => client.clearinghouseState({ user: WALLET }),
        catch: (cause) =>
          new HyperliquidError({
            message: "Retreiving Perp Positions Failed",
            cause,
          }),
      }).pipe(Effect.retry(promiseRetry));

      const spotClearinghouseState = Effect.tryPromise({
        try: () => client.spotClearinghouseState({ user: WALLET }),
        catch: (cause) =>
          new HyperliquidError({
            message: "Retreiving Spot Positions Failed",
            cause,
          }),
      }).pipe(Effect.retry(promiseRetry));

      const meta = Effect.tryPromise({
        try: () => client.meta(),
        catch: (cause) => new HyperliquidError({ message: "Retreiving Meta Failed", cause }),
      }).pipe(Effect.retry(promiseRetry));

      const allMids = Effect.tryPromise({
        try: () => client.allMids(),
        catch: (cause) => new HyperliquidError({ message: "allMids failed", cause }),
      }).pipe(Effect.retry(promiseRetry));

      const l2Book = Effect.fn("HyperliquidService.l2Book")(function* (coin: string) {
        return yield* Effect.tryPromise({
          try: () => client.l2Book({ coin }),
          catch: (cause) =>
            new HyperliquidError({
              message: "Retreiving l2Book failed",
              cause,
            }),
        }).pipe(Effect.retry(promiseRetry));
      });

      const openOrders = Effect.tryPromise({
        try: () => client.openOrders({ user: WALLET }),
        catch: (cause) =>
          new HyperliquidError({
            message: "Retreiving Open Orders failed",
            cause,
          }),
      }).pipe(Effect.retry(promiseRetry));

      const createLimitOrder = Effect.fn("Hyperliquid.createLimitOrder")(function* ({
        ticker,
        size,
        side,
      }: {
        ticker: string;
        size: BigDecimal.BigDecimal;
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
                    s: BigDecimal.toNumberUnsafe(size),
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

        const limitOrderRetry = Schedule.forever.pipe(
          Schedule.addDelay(() => Effect.succeed("2000 millis")),
          Schedule.jittered,
        );

        return yield* attempt.pipe(Effect.retry(limitOrderRetry));
      });

      const marketOrderRebalance = Effect.fn("Hyperliquid.marketOrderRebalance")(function* ({
        desiredPositions,
      }: {
        desiredPositions: TDesiredPosition[];
      }) {
        const { assetPositions: currentPositions } = yield* clearinghouseState;

        const tickersToMarketOrder = [
          ...filterTickersToRebalance(desiredPositions, currentPositions).values(),
        ];

        const [failed, ordered] = yield* Effect.partition(tickersToMarketOrder, (desiredPosition) =>
          Effect.gen(function* () {
            const ticker = desiredPosition.exchangeTicker;
            const mids = yield* allMids;
            const currentPosition = currentPositions.find((p) => p.position.coin === ticker);
            const { size, side } = calculateOrderSize(
              desiredPosition,
              BigDecimal.fromStringUnsafe(currentPosition ? currentPosition.position.szi : "0"),
              mids,
            );
            if (!BigDecimal.isGreaterThan(size, ZERO))
              return { ticker, status: "skipped" as const };
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
                      s: BigDecimal.toNumberUnsafe(size),
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

class TradingConfigService extends Context.Service<
  TradingConfigService,
  {
    readonly getConfig: Effect.Effect<TConfig, ConfigError>;
    readonly getTickers: Effect.Effect<TTicker[], ConfigError>;
    readonly getVolScaledWeights: (config: TConfig) => Effect.Effect<WeightedTicker[], ConfigError>;
  }
>()("Hyperliquid/MarketDataService") {
  static readonly layer = Layer.effect(
    TradingConfigService,
    Effect.gen(function* () {
      return TradingConfigService.of({
        getConfig: getConfig("hyperliquid").pipe(Effect.retry(promiseRetry)),
        getTickers: getTickers.pipe(Effect.retry(promiseRetry)),
        getVolScaledWeights: (config) =>
          getVolScaledWeights(config).pipe(Effect.retry(promiseRetry)),
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

      const isPositive = BigDecimal.isGreaterThanOrEqualTo(tokenAllocation, ZERO);
      const signedBuffer = dec(isPositive ? config.trade_buffer : -config.trade_buffer);
      const oppositeBuffer = dec(isPositive ? -config.trade_buffer : config.trade_buffer);

      const market = markets.find((m) => m.name === exchangeTicker);

      return {
        rwTicker: vw.ticker,
        exchangeTicker,
        desiredSize: tokenAllocation,
        upperBound: BigDecimal.multiply(tokenAllocation, BigDecimal.sum(signedBuffer, ONE)),
        lowerBound: BigDecimal.multiply(tokenAllocation, BigDecimal.sum(oppositeBuffer, ONE)),
        minOrderSizeChange: market ? getMinOrderSizeChange(market.szDecimals) : ZERO,
        szDecimals: market ? market.szDecimals : 1,
      };
    }),
  );
});

const filterTickersToRebalance = (
  desiredPositions: readonly TDesiredPosition[],
  currentPositions: ClearinghouseStateResponse["assetPositions"],
) => {
  const positionMap = new Map(
    currentPositions.map((p) => [p.position.coin, BigDecimal.fromStringUnsafe(p.position.szi)]),
  );

  const result = new Map<string, TDesiredPosition>();

  for (const dp of desiredPositions) {
    const currentSize = positionMap.get(dp.exchangeTicker);

    if (currentSize === undefined) {
      result.set(dp.exchangeTicker, dp);
      continue;
    }

    if (
      BigDecimal.isGreaterThanOrEqualTo(currentSize, dp.lowerBound) &&
      BigDecimal.isLessThanOrEqualTo(currentSize, dp.upperBound)
    ) {
      continue;
    }

    result.set(dp.exchangeTicker, dp);
  }
  return result;
};

function calculateOrderSize(
  desiredPosition: TDesiredPosition,
  currentPosition: BigDecimal.BigDecimal,
  allMids: AllMidsResponse,
): { size: BigDecimal.BigDecimal; side: "BUY" | "SELL" } {
  const { szDecimals, lowerBound, upperBound } = desiredPosition;
  const midPrice = allMids[desiredPosition.exchangeTicker];
  const minOrdersize = BigDecimal.round(
    BigDecimal.divideUnsafe(MINIMUM_ORDER_VALUE, BigDecimal.fromStringUnsafe(midPrice)),
    { scale: szDecimals, mode: "from-zero" },
  );

  if (
    BigDecimal.isGreaterThanOrEqualTo(currentPosition, lowerBound) &&
    BigDecimal.isLessThanOrEqualTo(currentPosition, upperBound)
  ) {
    return { size: ZERO, side: "BUY" };
  }
  if (BigDecimal.isLessThan(currentPosition, lowerBound)) {
    const gap = BigDecimal.subtract(lowerBound, currentPosition);

    const size = BigDecimal.isLessThan(gap, minOrdersize) ? minOrdersize : gap;

    const roundedUp = roundToDecimal(size, szDecimals, "from-zero");
    const roundedDown = roundToDecimal(size, szDecimals, "to-zero");

    if (BigDecimal.isLessThan(BigDecimal.sum(currentPosition, roundedUp), upperBound))
      return { size: roundedUp, side: "BUY" };

    if (BigDecimal.isLessThan(BigDecimal.sum(currentPosition, roundedDown), upperBound))
      return { size: roundedDown, side: "BUY" };

    return { size: ZERO, side: "BUY" };
  }

  if (BigDecimal.isGreaterThan(currentPosition, upperBound)) {
    const gap = BigDecimal.abs(BigDecimal.subtract(upperBound, currentPosition));

    const size = BigDecimal.isLessThan(gap, minOrdersize) ? minOrdersize : gap;

    const roundedUp = roundToDecimal(size, szDecimals, "from-zero");
    const roundedDown = roundToDecimal(size, szDecimals, "to-zero");

    if (BigDecimal.isGreaterThan(BigDecimal.sum(currentPosition, roundedUp), lowerBound))
      return { size: roundedUp, side: "SELL" };

    if (BigDecimal.isGreaterThan(BigDecimal.sum(currentPosition, roundedDown), lowerBound))
      return { size: roundedDown, side: "SELL" };

    return { size: ZERO, side: "SELL" };
  }

  return { size: ZERO, side: "BUY" };
}

/** Exact 10^-szDecimals, i.e. the smallest size step the venue accepts. */
function getMinOrderSizeChange(szDecimals: number): BigDecimal.BigDecimal {
  return BigDecimal.make(1n, szDecimals);
}

function roundToDecimal(
  value: BigDecimal.BigDecimal,
  szDecimals: number,
  roundingMode: BigDecimal.RoundingMode = "half-from-zero",
) {
  return BigDecimal.round(value, { scale: szDecimals, mode: roundingMode });
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
  const volAndWeight = yield* tradingConfig.getVolScaledWeights(config);
  const tickers = yield* tradingConfig.getTickers;
  const { assetPositions } = yield* hl.clearinghouseState;
  const meta = yield* hl.meta;

  const desiredPositions = yield* calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    meta.universe,
  );
  const tickersToRebalance = filterTickersToRebalance(desiredPositions, assetPositions);

  const rebalancePass = Effect.gen(function* () {
    const allMids = yield* hl.allMids;

    const orders = yield* hl.openOrders;
    const { assetPositions: updatedPositions } = yield* hl.clearinghouseState;

    for (const [ticker, desiredPosition] of tickersToRebalance) {
      const order = orders.find((o) => o.coin === ticker);

      if (!order) {
        const currentPosition = updatedPositions.find((p) => p.position.coin === ticker);
        const { size, side } = calculateOrderSize(
          desiredPosition,
          BigDecimal.fromStringUnsafe(currentPosition ? currentPosition.position.szi : "0"),
          allMids,
        );

        if (BigDecimal.isGreaterThan(size, ZERO)) {
          yield* hl.createLimitOrder({ ticker, size, side });
        } else {
          tickersToRebalance.delete(ticker);
        }
      } else {
        const book = yield* hl.l2Book(ticker);
        const bestPrice = book?.levels[order.side === "B" ? 0 : 1]?.[0]?.px;

        if (
          bestPrice &&
          BigDecimal.equals(
            BigDecimal.fromStringUnsafe(order.limitPx),
            BigDecimal.fromStringUnsafe(bestPrice),
          )
        )
          continue;

        yield* hl.cancelOrders([order]);

        const currentPosition = updatedPositions.find((p) => p.position.coin === ticker);

        const { size, side } = calculateOrderSize(
          desiredPosition,
          currentPosition ? BigDecimal.fromStringUnsafe(currentPosition.position.szi) : ZERO,
          allMids,
        );

        if (BigDecimal.isGreaterThan(size, ZERO)) {
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

  const openOrders = yield* hl.openOrders;
  yield* hl.cancelOrders(openOrders);
  const { ordered, failed } = yield* hl.marketOrderRebalance({ desiredPositions });

  const { assetPositions: finalPositions, crossMarginSummary } = yield* hl.clearinghouseState;
  const mids = yield* hl.allMids;

  const tickersOutOfBuffer = Array.from(
    filterTickersToRebalance(desiredPositions, finalPositions).values(),
  ).map((fr) => {
    const position = finalPositions.find((fp) => fp.position.coin === fr.exchangeTicker)?.position;

    const size = BigDecimal.fromStringUnsafe(position?.szi || "0");
    const midPrice = mids[fr.exchangeTicker];

    const gapToLower = BigDecimal.abs(BigDecimal.subtract(size, fr.lowerBound));
    const gapToUpper = BigDecimal.abs(BigDecimal.subtract(fr.upperBound, size));
    const gap = BigDecimal.isLessThan(gapToLower, gapToUpper) ? gapToLower : gapToUpper;
    const priceGap = BigDecimal.toNumberUnsafe(
      BigDecimal.multiply(gap, BigDecimal.fromStringUnsafe(midPrice)),
    );

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
  const { balances } = yield* hl.spotClearinghouseState;
  const usdcTotal = balances.find((b) => b.coin === "USDC")?.total || "1";
  const leverage = BigDecimal.round(
    BigDecimal.divideUnsafe(
      BigDecimal.fromStringUnsafe(crossMarginSummary.totalNtlPos),
      BigDecimal.fromStringUnsafe(usdcTotal),
    ),
    { scale: 2, mode: "half-from-zero" },
  );

  const message = `
  Hyperliquid Trading Complete

  ${status}
  Runtime: ${minutes}m ${seconds}s
  Market Order list: ${marketedList}
  Positions Out of Bounds: ${outOfBoundsList}
  Leverage: ${BigDecimal.format(leverage)}`;

  yield* telegram.send(message);

  return { finalPositions, tickersOutOfBuffer };
}).pipe(
  Effect.tapCause((cause) =>
    TelegramService.use((telegram) =>
      telegram.send(
        `Hyperliquid Trading Failed
        ${Cause.pretty(cause)}`,
      ),
    ).pipe(Effect.ignore),
  ),
);

export const handler: Handler = () => Effect.runPromise(program.pipe(Effect.provide(AppLayer)));
