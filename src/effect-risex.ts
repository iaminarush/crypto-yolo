import { Handler } from "aws-lambda";
import { BigDecimal, Clock, Context, Effect, Layer, Schedule, Schema } from "effect";
import { TelegramService, TradingConfigService, WeightedTicker } from "./effect-services";
import { Resource } from "sst";
import { ExchangeClient, formatWad, InfoClient, type Market, type Position } from "risex-client";
import { Database } from "../database.types";

class RisexError extends Schema.TaggedError<RisexError>()("RisexError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const ZERO = BigDecimal.fromBigInt(0n);
const ONE = BigDecimal.fromBigInt(1n);
const dec = BigDecimal.fromNumberUnsafe;

const promiseRetry = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
);

const makeRisex = Effect.gen(function* () {
  const WALLET = Resource.HYPERLIQUID_WALLET.value;
  const info = new InfoClient({ baseUrl: "https://api.rise.trade" });
  const initClient = Effect.tryPromise({
    try: () => {
      const c = new ExchangeClient({
        account: WALLET,
        signerKey: Resource.RISEX_API_KEY.value,
        baseUrl: "https://api.rise.trade",
      });
      return c.init();
    },
    catch: (cause) => new RisexError({ message: "Exchange client init failed", cause }),
  });

  const client = yield* initClient;

  const markets = yield* Effect.tryPromise({
    try: () => info.getMarkets(),
    catch: (cause) => new RisexError({ message: "Retreiving markets failed", cause }),
  }).pipe(Effect.retry(promiseRetry));

  const positions = Effect.tryPromise({
    try: () => info.getAllPositions(WALLET),
    catch: (cause) => new RisexError({ message: "Retreiving positions failed", cause }),
  });

  return { markets, positions };
});

class RisexService extends Context.Service<RisexService>()("RisexService", { make: makeRisex }) {
  static readonly layer = Layer.effect(RisexService, RisexService.make);
}

const AppLayer = Layer.mergeAll(
  RisexService.layer,
  TradingConfigService.layer,
  TelegramService.layer,
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
});

export const handler: Handler = () => Effect.runPromise(program.pipe(Effect.provide(AppLayer)));

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
  const positionMap = new Map(
    currentPositions.map((p) => [p.market_id, BigDecimal.fromStringUnsafe(formatWad(p.size))]),
  );

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
