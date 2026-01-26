import ky from "ky";
import { EXTENDED_API } from "./constants";
import { fetchAndParse } from "./util.ts";
import { z } from "zod";
import { Resource } from "sst";

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
  size: string,
  price: string,
  id: string,
) =>
  fetchAndParse(
    () =>
      privateExtended
        .post("v1/order", {
          json: {
            market: ticker,
            side,
            size,
            price,
            type: "limit",
            postOnly: true,
            id,
          },
        })
        .json(),
    CreateOrderResponseSchema,
  );

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
