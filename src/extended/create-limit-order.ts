import { getFees } from "./api/fees";
import { getMarket } from "./api/markets";
import { placeOrder } from "./api/order";
import { getOrderbook } from "./api/orderbook";
import { getStarknetDomain } from "./api/starknet";
import { init } from "./init";
import { Order } from "./models/order";
import type { OrderSide } from "./models/order.types.ts";
import { createOrderContext } from "./utils/create-order-context";
import { Decimal } from "./utils/number";
import { roundToMinChange } from "./utils/round-to-min-change";

const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 2000;

const getRandomDelay = () =>
  Math.floor(Math.random() * (MAX_RETRY_DELAY_MS - MIN_RETRY_DELAY_MS + 1)) +
  MIN_RETRY_DELAY_MS;

export type CreateOrderResult =
  | { status: "success"; id: string }
  | { status: "skipped"; reason: "below_min_order_size" }
  | { status: "error"; error: unknown };

const isPriceInvalidError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;

  const err = error as {
    data?: {
      status?: string;
      error?: { code?: number; message?: string };
    };
  };
  return err.data?.status === "ERROR" && err.data?.error?.code === 1141;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createLimitOrder = async ({
  ticker,
  side,
  size,
  cancelId,
}: {
  ticker: string;
  size: Decimal;
  side: OrderSide;
  cancelId?: string;
}): Promise<CreateOrderResult> => {
  const { starkPrivateKey, vaultId } = await init();

  const market = await getMarket(ticker);

  if (size.lt(market.tradingConfig.minOrderSize)) {
    return { status: "skipped", reason: "below_min_order_size" };
  }

  const fees = await getFees({ marketName: ticker });
  const starknetDomain = await getStarknetDomain();

  while (true) {
    try {
      const orderbook = await getOrderbook(ticker);
      const orderPrice =
        side === "BUY" ? orderbook.bid[0].price : orderbook.ask[0].price;

      const ctx = createOrderContext({
        market,
        fees,
        starknetDomain,
        vaultId,
        starkPrivateKey,
      });

      const order = Order.create({
        marketName: ticker,
        orderType: "LIMIT",
        side,
        amountOfSynthetic: roundToMinChange(
          size,
          market.tradingConfig.minOrderSizeChange,
          Decimal.ROUND_DOWN,
        ),
        price: roundToMinChange(
          orderPrice,
          market.tradingConfig.minPriceChange,
          Decimal.ROUND_DOWN,
        ),
        timeInForce: "GTT",
        reduceOnly: false,
        postOnly: true,
        cancelId,
        ctx,
      });

      const result = await placeOrder({ order });

      return { status: "success", id: result.id.toString() };
    } catch (error) {
      if (isPriceInvalidError(error)) {
        await sleep(getRandomDelay());
        continue;
      }

      console.error(`Order failed for ${ticker}:`, error);
      return { status: "error", error };
    }
  }
};
