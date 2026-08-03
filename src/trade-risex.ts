import type { Handler } from "aws-lambda";
import BN from "bignumber.js";
import type { Database } from "database.types";
import { InfoClient, type Market } from "risex-client";
import {
  getConfig,
  getDemeanedWeightsAndVols,
  getTickers,
  getWeights,
} from "./api";
import { Resource } from "sst";

export const handler: Handler = async () => {
  const WALLET = Resource.HYPERLIQUID_WALLET.value;
  const info = new InfoClient({ baseUrl: "https://api.rise.trade" });
  const config = await getConfig("risex");
  const weights = await getWeights();
  const markets = await info.getMarkets();
  const tickers = await getTickers();

  const positions = await info.getAllPositions(WALLET);

  const filteredMarkets = tickers
    .filter(
      (t) =>
        markets.some((m) => m.market_id === t.risex_ticker) &&
        weights.data.some((w) => w.ticker === t.rbw_ticker),
    )
    .map((fm) => fm.rbw_ticker);

  const volAndWeight = await getDemeanedWeightsAndVols(config, filteredMarkets);

  const desiredPositions = calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    markets,
  );

  const tickersToRebalance = filterTickersToRebalance(
    desiredPositions,
    assetPositions,
  );
};

const calculateDesiredPositions = (
  volAndWeight: Awaited<ReturnType<typeof getDemeanedWeightsAndVols>>,
  tickers: Awaited<ReturnType<typeof getTickers>>,
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

    const isPositive = tokenAllocation.gte(0);

    const market = markets.find((m) => m.market_id === exchangeTicker);
    if (!market) throw new Error(`No risex market for ${vw.ticker}`);

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
      minOrderSizeChange: market.config.min_order_size,
      szDecimals: market.config.step_size,
    };
  });
};
