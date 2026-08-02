import type { Handler } from "aws-lambda";
import type { Database } from "database.types";
import { InfoClient, type Market } from "risex-client";
import {
  getConfig,
  getDemeanedWeightsAndVols,
  getTickers,
  getWeights,
} from "./api";

export const handler: Handler = async () => {
  const info = new InfoClient();
  const config = await getConfig("risex");
  const weights = await getWeights();
  const markets = await info.getMarkets();
  const tickers = await getTickers();

  const filteredMarkets = tickers
    .filter(
      (t) =>
        markets.some((m) => m.market_id === t.risex_ticker) &&
        weights.data.some((w) => w.ticker === t.rbw_ticker),
    )
    .map((fm) => fm.rbw_ticker);

  const volAndWeight = await getDemeanedWeightsAndVols(config, filteredMarkets);

  // const desiredPositions = calculateDesiredPositions(
  //   volAndWeight,
  //   tickers,
  //   config,
  //   markets,
  // );
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
};
