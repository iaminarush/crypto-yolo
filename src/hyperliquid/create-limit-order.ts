import {
  ApiRequestError,
  ExchangeClient,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import { formatPrice, SymbolConverter } from "@nktkas/hyperliquid/utils";
import type BigNumber from "bignumber.js";
import { Resource } from "sst";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 2000;

const getRandomDelay = () =>
  Math.floor(Math.random() * (MAX_RETRY_DELAY_MS - MIN_RETRY_DELAY_MS + 1)) +
  MIN_RETRY_DELAY_MS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createLimitOrder = async ({
  ticker,
  size,
  side,
}: {
  ticker: string;
  size: BigNumber;
  side: "BUY" | "SELL";
}) => {
  const wallet = privateKeyToAccount(Resource.HYPERLIQUID_KEY.value as Hex);
  const isBuy = side === "BUY";

  const transport = new HttpTransport();
  const converter = await SymbolConverter.create({ transport });
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  const assetId = converter.getAssetId(ticker);
  const szDecimals = converter.getSzDecimals(ticker);

  if (assetId === undefined || szDecimals === undefined)
    return { status: "skipped", reason: "AssetId or szDecimals not found" };

  while (true) {
    const book = await info.l2Book({ coin: ticker });

    const price = book?.levels[isBuy ? 0 : 1]?.[0].px;

    if (!price) {
      return { status: "skipped", reason: "No bid/ask price found" };
    }

    try {
      const result = await exchange.order({
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
      });
      return result;
    } catch (error) {
      if (error instanceof ApiRequestError) {
        await sleep(getRandomDelay());
        continue;
      }

      return { status: "error", error };
    }
  }
};
