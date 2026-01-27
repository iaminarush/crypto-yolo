import ky from "ky";
import { EXTENDED_API } from "@/constants";
import { fetchAndParse, generateNonce } from "@/util";
import { addHours } from "date-fns";
import { z } from "zod";
import { Resource } from "sst";
import BigNumber from "bignumber.js";
import { signMessage } from "./signing";

const VAULT_ID = 110816;

const publicExtended = ky.create({
  prefixUrl: `${EXTENDED_API}/`,
});

const privateExtended = ky.create({
  headers: {
    "X-Api-Key": Resource.EXTENDED_API_KEY.value,
  },
  prefixUrl: `${EXTENDED_API}/`,
});

export const OrderbookLevelSchema = z.object({
  qty: z.string(),
  price: z.string(),
});

export const OrderbookSchema = z.object({
  data: z.object({
    market: z.string(),
    bid: z.array(OrderbookLevelSchema),
    ask: z.array(OrderbookLevelSchema),
  }),
});

export type Orderbook = z.infer<typeof OrderbookSchema>;

export const getOrderbook = async (ticker: string) =>
  fetchAndParse(
    () => publicExtended.get(`v1/market/${ticker}/orderbook`).json(),
    OrderbookSchema,
  );

export const MarketConfigSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      tradingConfig: z.object({
        minOrderSize: z.string(),
        minOrderSizeChange: z.string(),
        minPriceChange: z.string(),
        maxMarketOrderValue: z.string(),
        maxLimitOrderValue: z.string(),
        maxPositionValue: z.string(),
        maxLeverage: z.string(),
        maxNumOrders: z.string(),
        limitPriceCap: z.string(),
        limitPriceFloor: z.string(),
      }),
      l2Config: z.object({
        type: z.string(),
        collateralId: z.string(),
        collateralResolution: z.number(),
        syntheticId: z.string(),
        syntheticResolution: z.number(),
      }),
    }),
  ),
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

export const getMarketConfig = async (ticker: string) =>
  fetchAndParse(
    () =>
      publicExtended
        .get("v1/info/markets", {
          searchParams: { market: ticker },
        })
        .json(),
    MarketConfigSchema,
  );

export const CreateOrderResponseSchema = z.object({
  data: z.object({
    id: z.number(),
    externalId: z.string().optional(),
  }),
});

//TODO: Reviewed up to here

export type CreateOrderResponse = z.infer<typeof CreateOrderResponseSchema>;

export const createOrder = async (
  ticker: string,
  side: "buy" | "sell",
  qty: string,
  price: string,
  id: string,
) => {
  const nonce = generateNonce();
  const expiryEpochMillis = addHours(new Date(), 1).getTime();
  return fetchAndParse(
    () =>
      privateExtended
        .post("v1/order", {
          json: {
            id,
            market: ticker,
            type: "limit",
            side,
            qty,
            price,
            postOnly: true,
            timeInForce: "GTT",
            expiryEpochMillis,
            fee: "0",
            nonce,
            settlement: {
              signature: "",
              starkKey: Resource.EXTENDED_STARKEX_KEY.value,
              collateralPosition: new BigNumber(VAULT_ID).toString(10),
            },
          },
        })
        .json(),
    CreateOrderResponseSchema,
  );
};

export const OrderSchema = z.object({
  data: z.object({
    id: z.number(),
    market: z.string(),
    side: z.enum(["buy", "sell"]),
    size: z.string(),
    filledSize: z.string(),
    price: z.string(),
    status: z.enum(["open", "partial", "filled", "canceled", "rejected"]),
    avgPrice: z.string().optional(),
    createdAt: z.number(),
  }),
});

export type Order = z.infer<typeof OrderSchema>;

export const getOrder = async (orderId: string) =>
  fetchAndParse(
    () => privateExtended.get(`v1/order/${orderId}`).json(),
    OrderSchema,
  );

export const cancelOrder = async (orderId: string) => {
  await privateExtended.delete(`v1/order/${orderId}`);
};

export const UserPositionsSchema = z.object({
  data: z.array(
    z.object({
      market: z.string(),
      size: z.string(),
      entryPrice: z.string(),
      markPrice: z.string(),
      pnl: z.string(),
    }),
  ),
});

export type UserPositions = z.infer<typeof UserPositionsSchema>;

export const getPositions = async () =>
  fetchAndParse(
    () => privateExtended.get("v1/user/positions").json(),
    UserPositionsSchema,
  );
