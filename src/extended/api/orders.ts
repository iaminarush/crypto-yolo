import { axiosClient } from './axios.ts'
import { UserOrderResponseSchema, UserOrdersResponseSchema } from './orders.schema.ts'

export const getOrders = async ({ marketsNames }: { marketsNames?: string[] }) => {
  const { data } = await axiosClient.get<unknown>('/api/v1/user/orders', {
    params: {
      market: marketsNames,
    },
  })

  return UserOrdersResponseSchema.parse(data).data
}

export const getOrder = async (orderId: string) => {
  const { data } = await axiosClient.get<unknown>(`/api/v1/user/orders/${orderId}`)

  return UserOrderResponseSchema.parse(data).data
}
