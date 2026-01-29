import { axiosClient } from "./axios.ts";

export const cancelOrder = async (orderId: string) => {
  const { data } = await axiosClient.delete<unknown>(`/api/v1/user/orders/${orderId}`);
  return data;
};
