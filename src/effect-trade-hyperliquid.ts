import {
  type AllMidsResponse,
  type ClearinghouseStateResponse,
  ExchangeClient,
  HttpTransport,
  InfoClient,
  type MetaResponse,
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

const SLEEP_MS = 2250;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const MINIMUM_ORDER_VALUE = BN(10);

export const handler: Handler = async () => {};

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

class TickerMappingError extends Schema.TaggedError<TickerMappingError>()("TickerMappingError", {
  ticker: Schema.String,
}) {}

class OrderError extends Schema.TaggedError<OrderError>()("OrderError", {
  ticker: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

class HyperliquidError extends Schema.TaggedError<HyperliquidError>()("HyperliquidError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  message: Schema.String,
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
      const wallet = yield* Effect.try({
        try: () => privateKeyToAccount(Resource.HYPERLIQUID_KEY.value as Hex),
        catch: (e) =>
          new HyperliquidError({
            message: "Wallet initialization failed",
            cause: e,
          }),
      });
      const transport = new HttpTransport();

      const converter = yield* Effect.tryPromise({
        try: () => SymbolConverter.create({ transport }),
        catch: (e) =>
          new HyperliquidError({
            message: "Symbol Converter failed",
            cause: e,
          }),
      });

      return HyperliquidService.of({
        infoClient: new InfoClient({ transport }),
        exchangeClient: new ExchangeClient({ transport, wallet }),
        converter,
        wallet: WALLET,
      });
    }),
  );
}

type Config = Effect.Success<typeof getConfigEff>;
type Tickers = Effect.Success<typeof getTickersEff>;
type WeightsAndVols = Effect.Success<ReturnType<typeof getWeightsAndVolEff>>;

const getConfigEff = Effect.tryPromise({
  try: () => getConfig("hyperliquid"),
  catch: (e) => new ConfigError({ message: "Retreiving Config Failed", cause: e }),
});

const getTickersEff = Effect.tryPromise({
  try: () => getTickers(),
  catch: (e) => new ConfigError({ message: "Retreiving Tickers Failed", cause: e }),
});

const getWeightsAndVolEff = (config: Config) =>
  Effect.tryPromise({
    try: () => getWeightsAndVolatilities(config),
    catch: (e) =>
      new ConfigError({
        message: "Retreiving Weights and Vol Failed",
        cause: e,
      }),
  });

const clearingHouseStateEff = HyperliquidService.use((h) =>
  Effect.tryPromise({
    try: () => h.infoClient.clearinghouseState({ user: h.wallet }),
    catch: (e) => new HyperliquidError({ message: "Clearinghouse state failed", cause: e }),
  }),
);

const metaEff = HyperliquidService.use((h) =>
  Effect.tryPromise({
    try: () => h.infoClient.meta(),
    catch: (e) => new HyperliquidError({ message: "Meta failed", cause: e }),
  }),
);

const calculateDesiredPositions = (
  volAndWeight: WeightsAndVols,
  tickers: Tickers,
  config: Database["public"]["Tables"]["exchange"]["Row"],
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
