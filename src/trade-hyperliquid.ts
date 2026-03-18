import {
  type AllMidsResponse,
  type ClearinghouseStateResponse,
  ExchangeClient,
  HttpTransport,
  InfoClient,
  type MetaResponse,
} from "@nktkas/hyperliquid";
import { formatPrice, SymbolConverter } from "@nktkas/hyperliquid/utils";
import type { Handler } from "aws-lambda";
import BN from "bignumber.js";
import type { Database } from "database.types";
import { Resource } from "sst";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig, getTickers, getWeightsAndVolatilities } from "./api";
import { SLIPPAGE } from "./constants";
import { createLimitOrder } from "./hyperliquid/create-limit-order";
import { sendTelegramMessage } from "./util";

const SLEEP_MS = 1000;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const MINIMUM_ORDER_VALUE = BN(10);

export const handler: Handler = async () => {
  const startTime = Date.now();
  sendTelegramMessage("Hyperliquid Lambda Started");

  const WALLET = Resource.HYPERLIQUID_WALLET.value as Hex;
  const transport = new HttpTransport();
  const client = new InfoClient({ transport });
  const wallet = privateKeyToAccount(Resource.HYPERLIQUID_KEY.value as Hex);
  const converter = await SymbolConverter.create({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

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
    const allMids = await client.allMids();
    for (const [ticker, desiredPosition] of tickersToRebalance) {
      const order = await getOpenOrder(client, ticker);

      if (!order) {
        const { assetPositions: updatedPositions } =
          await client.clearinghouseState({
            user: WALLET,
          });
        const currentPosition = updatedPositions.find(
          (p) => p.position.coin === ticker,
        );
        const { size, side } = calculateOrderSize(
          desiredPosition,
          BN(currentPosition ? currentPosition.position.szi : 0),
          allMids,
        );

        if (size.gt(0)) {
          await createLimitOrder({ ticker, size, side });
        } else {
          tickersToRebalance.delete(ticker);
        }
      } else {
        const book = await client.l2Book({ coin: ticker });
        const bestPrice = book?.levels[order.side === "B" ? 0 : 1]?.[0].px;

        if (bestPrice && BN(order.limitPx).eq(bestPrice)) continue;

        try {
          await exchange.cancel({
            cancels: [
              { a: converter.getAssetId(order.coin) || "", o: order.oid },
            ],
          });
        } catch (error) {
          console.error(`Cancel failed for ${order.coin} ${order.oid}:`, error);
          continue;
        }

        const updatedPositions = await client.clearinghouseState({
          user: WALLET,
        });
        const currentPosition = updatedPositions.assetPositions.find(
          (p) => p.position.coin === ticker,
        );

        const { size, side } = calculateOrderSize(
          desiredPosition,
          currentPosition ? BN(currentPosition.position.szi) : BN(0),
          allMids,
        );

        if (size.gt(0)) {
          await createLimitOrder({ ticker, size, side });
        } else {
          tickersToRebalance.delete(ticker);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }

  const openOrders = await client.openOrders({ user: WALLET });
  await exchange.cancel({
    cancels: openOrders.map((o) => ({
      a: converter.getAssetId(o.coin) || "",
      o: o.oid,
    })),
  });
  const { assetPositions: postTradePositions } =
    await client.clearinghouseState({ user: WALLET });

  const tickersToMarketOrder = filterTickersToRebalance(
    desiredPositions,
    postTradePositions,
  );

  for (const [ticker, desiredPosition] of tickersToMarketOrder) {
    const allMids = await client.allMids();
    const currentPosition = postTradePositions.find(
      (p) => p.position.coin === ticker,
    );
    const { size, side } = calculateOrderSize(
      desiredPosition,
      BN(currentPosition ? currentPosition.position.szi : 0),
      allMids,
    );

    if (size.gt(0)) {
      const mid = allMids[ticker];
      const price =
        parseFloat(mid) * (1 + (side === "BUY" ? SLIPPAGE : -SLIPPAGE));
      await exchange.order({
        orders: [
          {
            a: converter.getAssetId(ticker) || "",
            b: side === "BUY",
            p: formatPrice(price, converter.getSzDecimals(ticker) || 0),
            s: size.toNumber(),
            r: false,
            t: { limit: { tif: "Gtc" } },
          },
        ],
      });
    }
  }

  const { assetPositions: finalPositions } = await client.clearinghouseState({
    user: WALLET,
  });

  const allMids = await client.allMids();

  const tickersOutOfBuffer = Array.from(
    filterTickersToRebalance(desiredPositions, finalPositions).values(),
  ).map((fr) => {
    const position = finalPositions.find(
      (fp) => fp.position.coin === fr.exchangeTicker,
    )?.position;

    const size = BN(position?.szi || 0);
    const midPrice = allMids[fr.exchangeTicker];

    const gapToLower = size.minus(fr.lowerBound).abs();
    const gapToUpper = fr.upperBound.minus(size).abs();
    const gap = gapToLower.lt(gapToUpper) ? gapToLower : gapToUpper;
    const priceGap = gap.times(midPrice).toNumber();

    return {
      ...fr,
      size:
        finalPositions.find((fp) => fp.position.coin === fr.exchangeTicker)
          ?.position.szi || "0",
      priceGap,
    };
  });

  const runtimeMs = Date.now() - startTime;
  const timedOut = runtimeMs >= MAX_RUNTIME_MS;
  const minutes = Math.floor(runtimeMs / 60000);
  const seconds = Math.floor((runtimeMs % 60000) / 1000);

  const status = tickersToRebalance.size === 0 ? "Success" : "Incomplete";
  const timeout = timedOut ? " (Timed out)" : "";
  const remainingList =
    tickersToRebalance.size > 0
      ? Array.from(tickersToRebalance.keys()).join(", ")
      : "None";
  const outOfBoundsList =
    tickersOutOfBuffer.length > 0
      ? tickersOutOfBuffer
          .map((t) => `${t.exchangeTicker} $${t.priceGap}`)
          .join(", ")
      : "None";

  const message = `
  Hyperliquid Trading Complete

  ${status}${timeout}
  Runtime: ${minutes}m ${seconds}s
  Remaining: ${remainingList}
  Positions Out of Bounds: ${outOfBoundsList}
  `;

  await sendTelegramMessage(message).catch(console.error);

  return { finalPositions, tickersOutOfBuffer };
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
        ? (vw.token_allocation as unknown as BN)
        : new BN(0);

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
      minOrderSizeChange: market
        ? getMinOrderSizeChange(market.szDecimals)
        : BN(0),
      szDecimals: market ? market.szDecimals : 1,
    };
  });
};

type TDesiredPosition = ReturnType<typeof calculateDesiredPositions>[number];

const filterTickersToRebalance = (
  desiredPositions: TDesiredPosition[],
  currentPositions: ClearinghouseStateResponse["assetPositions"],
) => {
  const positionMap = new Map(
    currentPositions.map((p) => [p.position.coin, BN(p.position.szi)]),
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

function calculateOrderSize(
  desiredPosition: TDesiredPosition,
  currentPosition: BN,
  allMids: AllMidsResponse,
): { size: BN; side: "BUY" | "SELL" } {
  const { szDecimals, lowerBound, upperBound } = desiredPosition;
  const midPrice = allMids[desiredPosition.exchangeTicker];
  const minOrdersize = MINIMUM_ORDER_VALUE.div(midPrice).decimalPlaces(
    szDecimals,
    BN.ROUND_UP,
  );

  if (currentPosition.gte(lowerBound) && currentPosition.lte(upperBound)) {
    return { size: BN(0), side: "BUY" };
  }
  if (currentPosition.lt(lowerBound)) {
    const gap = lowerBound.minus(currentPosition);

    const size = gap.lt(minOrdersize) ? minOrdersize : gap;

    const roundedUp = roundToDecimal(size, szDecimals, BN.ROUND_UP);
    const roundedDown = roundToDecimal(size, szDecimals, BN.ROUND_DOWN);

    if (currentPosition.plus(roundedUp).gt(upperBound)) {
      if (currentPosition.plus(roundedDown).gt(upperBound)) {
        return { size: BN(0), side: "BUY" };
      } else {
        return { size: roundedDown, side: "BUY" };
      }
    }

    return { size: roundedUp, side: "BUY" };
  }

  if (currentPosition.gt(desiredPosition.upperBound)) {
    const gap = desiredPosition.upperBound
      .minus(currentPosition)
      .absoluteValue();

    const size = gap.lt(minOrdersize) ? minOrdersize : gap;

    const roundedUp = roundToDecimal(size, szDecimals, BN.ROUND_UP);
    const roundedDown = roundToDecimal(size, szDecimals, BN.ROUND_DOWN);

    if (currentPosition.minus(roundedUp).lt(lowerBound)) {
      if (currentPosition.minus(roundedDown).lt(lowerBound)) {
        return { size: BN(0), side: "SELL" };
      } else {
        return { size: roundedDown, side: "SELL" };
      }
    }

    return { size: roundedUp, side: "SELL" };
  }

  return { size: BN(0), side: "BUY" };
}

function getMinOrderSizeChange(szDecimals: number): BN {
  return new BN(1).dividedBy(new BN(10).pow(szDecimals));
}

function roundToDecimal(
  value: BN,
  szDecimals: number,
  roundingMode?: BN.RoundingMode,
) {
  return value.decimalPlaces(szDecimals, roundingMode);
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
