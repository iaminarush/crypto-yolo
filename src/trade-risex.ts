import type { Handler } from "aws-lambda";
import type { Database } from "database.types";
import { getConfig, getTickers, getWeightsAndVolatilities } from "./api";
import { InfoClient, Market } from "risex-client";

export const handler: Handler = async () => {
  const config = await getConfig("risex");
  const volAndWeight = await getWeightsAndVolatilities(config);
  const tickers = await getTickers();
  const info = new InfoClient();

  const markets = await info.getMarkets();

  const desiredPositions = calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    markets,
  );
};

const calculateDesiredPositions = (
  volAndWeight: Awaited<ReturnType<typeof getWeightsAndVolatilities>>,
  tickers: Awaited<ReturnType<typeof getTickers>>,
  config: Database["public"]["Tables"]["exchange"]["Row"],
  markets: Market[],
) => {
  const tickerMap = new Map(
    tickers
      .filter((t) => markets.some((m) => m.name === t.risex_ticker))
      .map((t) => [t.rbw_ticker, t.risex_ticker]),
  );
};
