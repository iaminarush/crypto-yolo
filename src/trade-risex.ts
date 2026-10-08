import { Handler } from "aws-lambda";
import { BigDecimal, Clock, Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { TelegramService, TradingConfigService, WeightedTicker } from "./effect-services";
import { Resource } from "sst";
import {
  ExchangeClient,
  formatWad,
  InfoClient,
  OrderType,
  Side,
  StpMode,
  TimeInForce,
  type Market,
  type Position,
} from "risex-client";
import { Database } from "../database.types";
import { SLIPPAGE } from "./constants";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

class RisexError extends Schema.TaggedError<RisexError>()("RisexError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const PortfolioDetailsSchema = Schema.Struct({
  data: Schema.Struct({
    summary: Schema.Struct({ account_leverage: Schema.String }),
  }),
});

const ZERO = BigDecimal.fromBigInt(0n);
const ONE = BigDecimal.fromBigInt(1n);
const dec = BigDecimal.fromNumberUnsafe;
const sdec = BigDecimal.fromStringUnsafe;
const SLIPPAGE_BD = dec(SLIPPAGE);
const SLEEP_MS = 2250;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const RISEX_API = "https://api.rise.trade";

type OrderSide = "BUY" | "SELL";

type TTicker = Database["public"]["Tables"]["ticker"]["Row"];

const calculateDesiredPositions = (
  volAndWeight: WeightedTicker[],
  tickers: TTicker[],
  config: Database["public"]["Tables"]["exchange"]["Row"],
  markets: Market[],
) => {
  const tickerMap = new Map(
    tickers
      .filter((t) => markets.some((m) => m.market_id === t.risex_ticker))
      .map((t) => [t.rbw_ticker, t.risex_ticker]),
  );

  return volAndWeight.map((vw) => {
    const exchangeTicker = tickerMap.get(vw.ticker);
    if (!exchangeTicker) throw new Error(`No risex ticker for ${vw.ticker}`);

    const tokenAllocation = vw.token_allocation;

    const isPositive = BigDecimal.isGreaterThanOrEqualTo(tokenAllocation, ZERO);
    const signedBuffer = dec(isPositive ? config.trade_buffer : -config.trade_buffer);
    const oppositeBuffer = dec(isPositive ? -config.trade_buffer : config.trade_buffer);

    const market = markets.find((m) => m.market_id === exchangeTicker);
    if (!market) throw new Error(`No risex market for ${vw.ticker}`);

    return {
      rwTicker: vw.ticker,
      exchangeTicker,
      desiredSize: tokenAllocation,
      upperBound: BigDecimal.multiply(tokenAllocation, BigDecimal.sum(signedBuffer, ONE)),
      lowerBound: BigDecimal.multiply(tokenAllocation, BigDecimal.sum(oppositeBuffer, ONE)),
      minOrdersize: market.config.min_order_size,
      stepSize: market.config.step_size,
      stepPrice: market.config.step_price,
    };
  });
};

type TDesiredPosition = ReturnType<typeof calculateDesiredPositions>[number];

const filterTickersToRebalance = (
  desiredPositions: TDesiredPosition[],
  currentPositions: Position[],
) => {
  const positionMap = new Map(currentPositions.map((p) => [p.market_id, sdec(formatWad(p.size))]));

  const result = new Map<string, TDesiredPosition>();

  for (const dp of desiredPositions) {
    const currentSize = positionMap.get(dp.exchangeTicker);

    if (currentSize === undefined) {
      result.set(dp.exchangeTicker, dp);
      continue;
    }

    if (BigDecimal.between(currentSize, { minimum: dp.lowerBound, maximum: dp.upperBound })) {
      continue;
    }

    result.set(dp.exchangeTicker, dp);
  }
  return result;
};

function calculateOrderSize(
  desiredPosition: TDesiredPosition,
  currentPosition: BigDecimal.BigDecimal,
): { size: BigDecimal.BigDecimal; side: OrderSide } {
  const { stepSize, lowerBound, upperBound, minOrdersize } = desiredPosition;

  const step = sdec(stepSize);
  const minSize = sdec(minOrdersize);

  if (BigDecimal.between(currentPosition, { minimum: lowerBound, maximum: upperBound })) {
    return { size: ZERO, side: "BUY" };
  }

  if (BigDecimal.isLessThan(currentPosition, lowerBound)) {
    const gap = BigDecimal.subtract(lowerBound, currentPosition);

    const size = BigDecimal.isLessThan(gap, minSize) ? minSize : gap;

    const roundedUp = roundToMinOrdersize(size, step, "from-zero");
    const roundedDown = roundToMinOrdersize(size, step, "to-zero");

    if (BigDecimal.isLessThan(BigDecimal.sum(currentPosition, roundedUp), upperBound))
      return { size: roundedUp, side: "BUY" };

    if (BigDecimal.isLessThan(BigDecimal.sum(currentPosition, roundedDown), upperBound))
      return { size: roundedDown, side: "BUY" };

    return { size: ZERO, side: "BUY" };
  }

  if (BigDecimal.isGreaterThan(currentPosition, upperBound)) {
    const gap = BigDecimal.abs(BigDecimal.subtract(upperBound, currentPosition));

    const size = BigDecimal.isLessThan(gap, minSize) ? minSize : gap;

    const roundedUp = roundToMinOrdersize(size, step, "from-zero");
    const roundedDown = roundToMinOrdersize(size, step, "to-zero");

    if (BigDecimal.isGreaterThan(BigDecimal.sum(currentPosition, roundedUp), lowerBound))
      return { size: roundedUp, side: "SELL" };

    if (BigDecimal.isGreaterThan(BigDecimal.sum(currentPosition, roundedDown), lowerBound))
      return { size: roundedDown, side: "SELL" };

    return { size: ZERO, side: "SELL" };
  }
  return { size: ZERO, side: "BUY" };
}

function roundToMinOrdersize(
  size: BigDecimal.BigDecimal,
  step: BigDecimal.BigDecimal,
  mode: BigDecimal.RoundingMode,
): BigDecimal.BigDecimal {
  return BigDecimal.multiply(
    BigDecimal.round(BigDecimal.divideUnsafe(size, step), { scale: 0, mode }),
    step,
  );
}

const promiseRetry = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
);

const makeRisex = Effect.gen(function* () {
  const WALLET = Resource.HYPERLIQUID_WALLET.value;
  const info = new InfoClient({ baseUrl: RISEX_API });
  const initClient = Effect.tryPromise({
    try: () => {
      const c = new ExchangeClient({
        account: WALLET,
        signerKey: Resource.RISEX_API_KEY.value,
        baseUrl: RISEX_API,
      });
      return c.init();
    },
    catch: (cause) => new RisexError({ message: "Exchange client init failed", cause }),
  });

  const client = yield* initClient;

  const markets = yield* Effect.tryPromise({
    try: () => info.getMarkets(),
    catch: (cause) => new RisexError({ message: "Getting markets failed", cause }),
  }).pipe(Effect.retry(promiseRetry));

  const positions = Effect.tryPromise({
    try: () => info.getAllPositions(WALLET),
    catch: (cause) => new RisexError({ message: "Getting positions failed", cause }),
  }).pipe(Effect.retry(promiseRetry));

  const openOrders = Effect.tryPromise({
    try: () => info.getOpenOrders(WALLET),
    catch: (cause) => new RisexError({ message: "Getting open orders failed", cause }),
  }).pipe(Effect.retry(promiseRetry));

  const orderBook = Effect.fn("Risex.orderBook")(function* (marketId: number) {
    return yield* Effect.tryPromise({
      try: () => info.getOrderbook(marketId),
      catch: (cause) => new RisexError({ message: "Getting orderbook failed", cause }),
    });
  });

  const accountLeverage = Effect.fn("Risex.accountLeverage")(function* () {
    const url = new URL("/v1/portfolio/details", RISEX_API);
    url.searchParams.set("account", WALLET);

    return yield* HttpClient.get(url.toString()).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PortfolioDetailsSchema)),
      Effect.map((body) => sdec(body.data.summary.account_leverage)),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? new RisexError({
              message: `Portfolio details payload invalid: ${cause.message}`,
              cause,
            })
          : new RisexError({ message: "Getting portfolio details failed", cause }),
      ),
      Effect.retry(promiseRetry),
    );
  });

  const createLimitOrder = Effect.fn("Risex.createLimitOrder")(function* ({
    side,
    marketId,
    size,
    stepPrice,
    stepSize,
  }: {
    side: OrderSide;
    marketId: string;
    size: BigDecimal.BigDecimal;
    stepPrice: string;
    stepSize: string;
  }) {
    const sizeSteps = BigDecimal.toNumberUnsafe(
      BigDecimal.round(BigDecimal.divideUnsafe(size, sdec(stepSize)), {
        scale: 0,
        mode: "to-zero",
      }),
    );
    const attempt = Effect.gen(function* () {
      const book = yield* orderBook(Number(marketId));
      const price = sdec(side === "BUY" ? book.bids[0].price : book.asks[0].price);
      if (!price)
        return yield* new RisexError({ message: "No best bid/ask on orderbook", cause: book });

      const priceTicks = price.pipe(
        BigDecimal.divideUnsafe(sdec(stepPrice)),
        BigDecimal.round({ scale: 0, mode: side === "BUY" ? "to-zero" : "from-zero" }),
        BigDecimal.toNumberUnsafe,
      );
      if (side === "BUY") {
        yield* Effect.tryPromise({
          try: () => client.limitBuy(Number(marketId), sizeSteps, priceTicks, true),
          catch: (cause) => new RisexError({ message: "Limit buy failed", cause }),
        });
      } else if (side === "SELL") {
        yield* Effect.tryPromise({
          try: () => client.limitSell(Number(marketId), sizeSteps, priceTicks, true),
          catch: (cause) => new RisexError({ message: "Limit sell failed", cause }),
        });
      }
    });

    const limitOrderRetry = Schedule.forever.pipe(
      Schedule.addDelay(() => Effect.succeed("2000 millis")),
      Schedule.jittered,
    );

    return yield* attempt.pipe(Effect.retry(limitOrderRetry));
  });

  const marketOrderRebalance = Effect.fn("Risex.marketOrderRebalance")(function* ({
    desiredPositions,
  }: {
    desiredPositions: TDesiredPosition[];
  }) {
    const currentPositions = yield* positions;

    const tickersToMarketOrder = [
      ...filterTickersToRebalance(desiredPositions, currentPositions).values(),
    ];

    const [failed, ordered] = yield* Effect.partition(tickersToMarketOrder, (desiredPosition) =>
      Effect.gen(function* () {
        const marketId = desiredPosition.exchangeTicker;
        const currentPosition = currentPositions.find((p) => p.market_id === marketId);
        const { side, size } = calculateOrderSize(
          desiredPosition,
          currentPosition ? sdec(formatWad(currentPosition.size)) : ZERO,
        );

        if (BigDecimal.equals(size, ZERO)) return { marketId, status: "skipped" as const };

        const sizeSteps = size.pipe(
          BigDecimal.divideUnsafe(sdec(desiredPosition.stepSize)),
          BigDecimal.round({ scale: 0, mode: "to-zero" }),
          BigDecimal.toNumberUnsafe,
        );
        const book = yield* orderBook(Number(marketId));
        const price =
          side === "BUY"
            ? sdec(book.asks[0].price).pipe(BigDecimal.multiply(BigDecimal.sum(ONE, SLIPPAGE_BD)))
            : sdec(book.bids[0].price).pipe(
                BigDecimal.multiply(BigDecimal.subtract(ONE, SLIPPAGE_BD)),
              );
        const priceTicks = price.pipe(
          BigDecimal.divideUnsafe(sdec(desiredPosition.stepPrice)),
          BigDecimal.round({ scale: 0, mode: side === "BUY" ? "from-zero" : "to-zero" }),
          BigDecimal.toNumberUnsafe,
        );
        const result = yield* createMarketOrder({
          marketId: Number(marketId),
          side,
          sizeSteps,
          priceTicks,
        });

        return { ...result, status: "ok" as const };
      }),
    );

    return {
      failed,
      ordered: ordered.filter((o) => o.status !== "skipped"),
      skipped: ordered.filter((o) => o.status === "skipped"),
    };
  });

  const createMarketOrder = Effect.fn("RisexService.createMarketOrder")(function* ({
    marketId,
    side,
    sizeSteps,
    priceTicks,
  }: {
    marketId: number;
    side: OrderSide;
    sizeSteps: number;
    priceTicks: number;
  }) {
    return yield* Effect.tryPromise({
      try: () =>
        client.placeOrder({
          market_id: marketId,
          size_steps: sizeSteps,
          price_ticks: priceTicks,
          side: side === "BUY" ? Side.Long : Side.Short,
          order_type: OrderType.Market,
          time_in_force: TimeInForce.ImmediateOrCancel,
          post_only: false,
          reduce_only: false,
          stp_mode: StpMode.ExpireMaker,
          ttl_units: 0,
        }),
      catch: (cause) =>
        new RisexError({ message: `Market order failed for market id: ${marketId}`, cause }),
    });
  });

  const cancelAllOrders = Effect.fn("RisexService.cancelAllOrders")(function* (marketId: number) {
    return yield* Effect.tryPromise({
      try: () => client.cancelAllOrders(marketId),
      catch: (cause) =>
        new RisexError({ message: `Canceling order failed for market id: ${marketId}`, cause }),
    });
  });

  return {
    markets,
    positions,
    openOrders,
    orderBook,
    accountLeverage,
    createLimitOrder,
    createMarketOrder,
    marketOrderRebalance,
    cancelAllOrders,
  };
});

class RisexService extends Context.Service<RisexService>()("RisexService", { make: makeRisex }) {
  static readonly layer = Layer.effect(RisexService, RisexService.make);
}

const AppLayer = Layer.mergeAll(
  RisexService.layer,
  TradingConfigService.layer,
  TelegramService.layer,
  FetchHttpClient.layer,
);

const program = Effect.gen(function* () {
  const startTime = yield* Clock.currentTimeMillis;
  const risex = yield* RisexService;
  const tradingConfig = yield* TradingConfigService;
  const telegram = yield* TelegramService;

  const config = yield* tradingConfig.getConfig("risex");
  const weights = yield* tradingConfig.getWeights;
  const markets = risex.markets;
  const tickers = yield* tradingConfig.getTickers;
  const positions = yield* risex.positions;
  const filteredMarkets = tickers
    .filter(
      (t) =>
        markets.some((m) => m.market_id === t.risex_ticker) &&
        weights.some((w) => w.ticker === t.rbw_ticker),
    )
    .map((fm) => fm.rbw_ticker);

  const volAndWeight = yield* tradingConfig.getDemeanedVolScaledWeights(config, filteredMarkets);

  const desiredPositions = calculateDesiredPositions(volAndWeight, tickers, config, markets);

  const tickersToRebalance = filterTickersToRebalance(desiredPositions, positions);

  const rebalancePass = Effect.gen(function* () {
    const updatedPositions = yield* risex.positions;
    const orders = yield* risex.openOrders;
    for (const [marketId, desiredPosition] of tickersToRebalance) {
      const order = orders.find((o) => `${o.market_id}` === marketId);
      const { stepSize, stepPrice } = desiredPosition;

      if (!order) {
        const currentPosition = updatedPositions.find((p) => p.market_id === marketId);

        const { side, size } = calculateOrderSize(
          desiredPosition,
          sdec(currentPosition ? formatWad(currentPosition.size) : "0"),
        );

        if (BigDecimal.isGreaterThan(size, ZERO)) {
          yield* risex.createLimitOrder({ size, side, marketId, stepPrice, stepSize });
        } else {
          tickersToRebalance.delete(marketId);
        }
      } else {
        const book = yield* risex.orderBook(Number(marketId));
        const bestPrice = order.side === 0 ? book.bids[0].price : book.asks[0].price;

        if (
          bestPrice &&
          dec(order.price_ticks).pipe(
            BigDecimal.multiply(sdec(desiredPosition.stepPrice)),
            BigDecimal.equals(sdec(bestPrice)),
          )
        )
          continue;

        yield* risex.cancelAllOrders(Number(marketId));

        const positionsAfterCancel = yield* risex.positions;

        const updatedPosition = positionsAfterCancel.find((p) => p.market_id === marketId);
        const { size, side } = calculateOrderSize(
          desiredPosition,
          updatedPosition ? sdec(updatedPosition.size) : ZERO,
        );

        if (BigDecimal.isGreaterThan(size, ZERO)) {
          yield* risex.createLimitOrder({ size, side, marketId, stepPrice, stepSize });
        } else {
          tickersToRebalance.delete(marketId);
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

  const filteredRisexMarkets = new Set(
    tickers.filter((t) => filteredMarkets.includes(t.rbw_ticker)).map((t) => t.risex_ticker),
  );
  const openOrders = yield* risex.openOrders;
  const marketIds = [
    ...new Set(
      openOrders.map((o) => o.market_id).filter((id) => filteredRisexMarkets.has(String(id))),
    ),
  ];
  for (const marketId of marketIds) yield* risex.cancelAllOrders(marketId);

  const { ordered, failed } = yield* risex.marketOrderRebalance({ desiredPositions });

  yield* Effect.sleep(Duration.seconds(2));

  const finalPositions = yield* risex.positions;

  const tickersOutOfBuffer = yield* Effect.forEach(
    Array.from(filterTickersToRebalance(desiredPositions, finalPositions).values()),
    (fr) =>
      Effect.gen(function* () {
        const position = finalPositions.find((fp) => fp.market_id === fr.exchangeTicker);

        const size = position?.size ? sdec(position.size) : ZERO;
        const book = yield* risex.orderBook(Number(fr.exchangeTicker));
        const midPrice = (Number(book.bids[0].price) + Number(book.asks[0].price)) / 2;

        const gapToLower = BigDecimal.abs(BigDecimal.subtract(size, fr.lowerBound));
        const gapToUpper = BigDecimal.abs(BigDecimal.subtract(fr.upperBound, size));
        const gap = BigDecimal.isLessThan(gapToLower, gapToUpper) ? gapToLower : gapToUpper;
        const priceGap = BigDecimal.multiply(gap, dec(midPrice)).pipe(BigDecimal.toNumberUnsafe);

        return { ...fr, size, priceGap };
      }),
  );

  const runtimeMs = (yield* Clock.currentTimeMillis) - startTime;
  const minutes = Math.floor(runtimeMs / 60000);
  const seconds = Math.floor((runtimeMs % 60000) / 1000);

  const status =
    tickersToRebalance.size === 0
      ? "Maker on all orders"
      : failed.length > 0
        ? "Incomplete"
        : `${ordered.length} taker orders`;
  const marketedList = ordered.length > 0 ? ordered.map((o) => o.marketId).join(", ") : "None";
  const outOfBoundsList =
    tickersOutOfBuffer.length > 0
      ? tickersOutOfBuffer.map((t) => `${t.rwTicker} $${t.priceGap.toFixed(2)}`).join(", ")
      : "None";

  const leverage = BigDecimal.round(yield* risex.accountLeverage(), {
    scale: 2,
    mode: "half-from-zero",
  });

  yield* telegram.send(`
  Risex Trading Complete

  ${status}
  Runtime: ${minutes}m ${seconds}s
  Market Order list: ${marketedList}
  Positions Out of Bounds: ${outOfBoundsList}
  Leverage: ${BigDecimal.format(leverage)}`);

  return { finalPositions, tickersOutOfBuffer };
});

export const handler: Handler = () => Effect.runPromise(program.pipe(Effect.provide(AppLayer)));
