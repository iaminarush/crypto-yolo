import { getFees } from "./api/fees";
import { getMarket } from "./api/markets";
import { placeOrder } from "./api/order";
import { getStarknetDomain } from "./api/starknet";
import { init } from "./init";
import { Order } from "./models/order";
import type { OrderSide } from "./models/order.types";
import { createOrderContext } from "./utils/create-order-context";
import { Decimal } from "./utils/number";
import { roundToMinChange } from "./utils/round-to-min-change";

const SLIPPAGE = 0.005;

export const createMarketOrder = async ({
  ticker,
  size,
  side,
}: {
  ticker: string;
  size: Decimal;
  side: OrderSide;
}) => {
  const { starkPrivateKey, vaultId } = await init();

  const market = await getMarket(ticker);
  const fees = await getFees({ marketName: ticker });
  const starknetDomain = await getStarknetDomain();

  const ctx = createOrderContext({
    market,
    fees,
    starknetDomain,
    vaultId,
    starkPrivateKey,
  });

  const order = Order.create({
    marketName: ticker,
    orderType: "MARKET",
    side,
    amountOfSynthetic: roundToMinChange(
      size,
      market.tradingConfig.minOrderSizeChange,
      Decimal.ROUND_DOWN,
    ),
    price: roundToMinChange(
      side === "BUY"
        ? market.marketStats.askPrice.times(Decimal(1).plus(SLIPPAGE))
        : market.marketStats.bidPrice.times(Decimal(1).minus(SLIPPAGE)),
      market.tradingConfig.minOrderSizeChange,
      Decimal.ROUND_DOWN,
    ),
    timeInForce: "IOC",
    reduceOnly: false,
    postOnly: false,
    ctx,
  });

  const result = await placeOrder({ order });

  return result;
};
