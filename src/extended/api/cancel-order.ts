import z from "zod";
import { axiosClient } from "./axios.ts";

export const cancelOrder = async (orderId: string) => {
  const { data } = await axiosClient.delete<unknown>(
    `/api/v1/user/order/${orderId}`,
  );
  return CancelOrderResponseSchema.parse(data);
};

const CancelOrderResponseSchema = z.object({
  status: z.enum(["OK"]),
  data: z.object(),
});
