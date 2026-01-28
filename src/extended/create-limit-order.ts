import { getFees } from "./api/fees";
import { getMarket } from "./api/markets";
import { placeOrder } from "./api/order";
import { getStarknetDomain } from "./api/starknet";
import { init } from "./init";
import { Order } from "./models/order";
import { type OrderSide } from "./models/order.types.ts";
import { createOrderContext } from "./utils/create-order-context";
import { Decimal } from "./utils/number";
import { roundToMinChange } from "./utils/round-to-min-change";

export const createLimitOrder = async ({ ticker, side, orderSize, cancelId }: { ticker: string; side: OrderSide; orderSize: Decimal; cancelId?: string }) => {
  const { starkPrivateKey, vaultId } = await init();

  const market = await getMarket(ticker);
  const fees = await getFees({ marketName: ticker });
  const starknetDomain = await getStarknetDomain();

  const finalSize = orderSize.gt(market.tradingConfig.minOrderSize)
    ? orderSize
    : market.tradingConfig.minOrderSize;
  const orderPrice = side === "BUY"
    ? market.marketStats.bidPrice
    : market.marketStats.askPrice;

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
      finalSize,
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
};
