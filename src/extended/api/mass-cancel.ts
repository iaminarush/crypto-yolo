import { axiosClient } from "./axios";

export const massCancel = async () => {
  const { data } = await axiosClient.post<unknown>(
    `/api/v1/user/order/massCancel`,
    {
      cancelAll: true,
    },
  );

  return data;
};
