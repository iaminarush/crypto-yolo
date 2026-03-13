import {
  type ClearinghouseStateResponse,
  HttpTransport,
  InfoClient,
  type MetaResponse,
} from "@nktkas/hyperliquid";
import type { Handler } from "aws-lambda";
import BigNumber from "bignumber.js";
import type { Database } from "database.types";
import { Resource } from "sst";
import { getConfig, getTickers, getWeightsAndVolatilities } from "./api";

const MAX_RUNTIME_MS = 10 * 60 * 1000;

export const handler: Handler = async () => {
  const WALLET = Resource.HYPERLIQUID_WALLET.value;
  // const startMessage = `Hyperliquid Lambda Started!`;
  // ky.post(
  //   `https://api.telegram.org/bot${Resource.TELEGRAM_TOKEN.value}/sendMessage`,
  //   {
  //     json: {
  //       chat_id: Resource.TELEGRAM_ID.value,
  //       text: startMessage,
  //     },
  //   },
  // ).catch(console.error);
  //
  const startTime = Date.now();
  const transport = new HttpTransport();
  const client = new InfoClient({ transport });

  const config = await getConfig("hyperliquid");
  const volAndWeight = await getWeightsAndVolatilities(config);
  const tickers = await getTickers();
  const { assetPositions } = await client.clearinghouseState({
    user: WALLET,
  });
  const meta = await client.meta();

  const desiredPositions = calculateDesiredPositions(
    volAndWeight,
    tickers,
    config,
    meta.universe,
  );

  const tickersToRebalance = filterTickersToRebalance(
    desiredPositions,
    assetPositions,
  );

  while (
    Date.now() - startTime < MAX_RUNTIME_MS &&
    tickersToRebalance.size > 0
  ) {
    for (const [ticker, desiredPosition] of tickersToRebalance) {
      //TODO: Implement trading loop
      const order = await getOpenOrder(client, ticker);
      if (!order) {
      } else {
      }
    }
  }
};

const calculateDesiredPositions = (
  volAndWeight: Awaited<ReturnType<typeof getWeightsAndVolatilities>>,
  tickers: Awaited<ReturnType<typeof getTickers>>,
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
    if (!exchangeTicker)
      throw new Error(`No hyperliquid ticker for ${vw.ticker}`);

    const tokenAllocation =
      "token_allocation" in vw
        ? (vw.token_allocation as unknown as BigNumber)
        : new BigNumber(0);

    const isPositive = tokenAllocation.gte(0);

    const market = markets.find((m) => m.name === exchangeTicker);

    return {
      rwTicker: vw.ticker,
      exchangeTicker,
      desiredSize: tokenAllocation,
      upperBound: tokenAllocation.times(
        BigNumber(isPositive ? config.trade_buffer : -config.trade_buffer).plus(
          1,
        ),
      ),
      lowerBound: tokenAllocation.times(
        BigNumber(isPositive ? -config.trade_buffer : config.trade_buffer).plus(
          1,
        ),
      ),
      minOrderSize: market ? getMinOrderSize(market.szDecimals) : BigNumber(0),
    };
  });
};

type TDesiredPosition = ReturnType<typeof calculateDesiredPositions>[number];

const filterTickersToRebalance = (
  desiredPositions: TDesiredPosition[],
  currentPositions: ClearinghouseStateResponse["assetPositions"],
) => {
  const positionMap = new Map(
    currentPositions.map((p) => [p.position.coin, BigNumber(p.position.szi)]),
  );

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

function getMinOrderSize(szDecimals: number): BigNumber {
  return new BigNumber(1).dividedBy(new BigNumber(10).pow(szDecimals));
}

async function getOpenOrder(
  client: InfoClient<{
    transport: HttpTransport;
  }>,
  ticker: string,
) {
  const orders = await client.openOrders({
    user: Resource.HYPERLIQUID_WALLET.value,
  });

  return orders.find((o) => o.coin === ticker);
}
