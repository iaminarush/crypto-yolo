import { z } from "zod";
import { zodDecimal } from "../utils/zod";
import { axiosClient } from "./axios";

const BalanceDataSchema = z.object({
  collateralName: z.string(),
  balance: zodDecimal(),
  equity: zodDecimal(),
  availableForTrade: zodDecimal(),
  availableForWithdrawal: zodDecimal(),
  unrealisedPnl: zodDecimal(),
  initialMargin: zodDecimal(),
  marginRatio: zodDecimal(),
  exposure: zodDecimal(),
  leverage: zodDecimal(),
  updatedTime: z.number(),
});

export const BalanceResponseSchema = z.object({
  status: z.union([z.literal("OK"), z.literal("ERROR")]),
  data: BalanceDataSchema,
});

export type BalanceResponse = z.infer<typeof BalanceResponseSchema>;

export const getBalance = async () => {
  const { data } = await axiosClient.get("/api/v1/user/balance");
  return BalanceResponseSchema.parse(data).data;
};
