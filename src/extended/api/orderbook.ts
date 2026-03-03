import { z } from "zod";
import { axiosClient } from "./axios.ts";
import { zodDecimal } from "../utils/zod.ts";

const OrderbookLevelSchema = z.object({
  qty: zodDecimal(),
  price: zodDecimal(),
});

export const OrderbookSchema = z.object({
  status: z.enum(["OK", "ERROR"]),
  data: z.object({
    market: z.string(),
    bid: OrderbookLevelSchema.array(),
    ask: OrderbookLevelSchema.array(),
  }),
});

export type Orderbook = z.infer<typeof OrderbookSchema>;

export const getOrderbook = async (ticker: string) => {
  const { data } = await axiosClient.get<unknown>(
    `/api/v1/info/markets/${ticker}/orderbook`,
  );

  return OrderbookSchema.parse(data).data;
};
