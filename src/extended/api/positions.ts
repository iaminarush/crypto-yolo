import { z } from "zod";
import { axiosClient } from "./axios.ts";
import { zodDecimal, zodLong } from "../utils/zod.ts";

const PositionSchema = z.object({
  id: zodLong(),
  accountId: zodLong(),
  market: z.string(),
  side: z.enum(["LONG", "SHORT"]),
  leverage: zodDecimal(),
  size: zodDecimal(),
  value: zodDecimal(),
  openPrice: zodDecimal(),
  markPrice: zodDecimal(),
  liquidationPrice: zodDecimal().optional(),
  margin: zodDecimal(),
  unrealisedPnl: zodDecimal(),
  realisedPnl: zodDecimal(),
  tpTriggerPrice: zodDecimal().optional(),
  tpLimitPrice: zodDecimal().optional(),
  slTriggerPrice: zodDecimal().optional(),
  slLimitPrice: zodDecimal().optional(),
  adl: zodDecimal().optional(),
  maxPositionSize: zodDecimal().optional(),
  createdTime: z.number(),
  updatedTime: z.number(),
});

export const PositionsResponseSchema = z.object({ data: PositionSchema.array() });

export type Position = z.infer<typeof PositionSchema>;

export const getPositions = async (params?: { markets?: string[]; side?: "LONG" | "SHORT" }) => {
  const { data } = await axiosClient.get<unknown>("/api/v1/user/positions", {
    params: {
      market: params?.markets,
      side: params?.side,
    },
  });

  return PositionsResponseSchema.parse(data).data;
};
