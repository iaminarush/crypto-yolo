import { z } from "zod";

export const clamp = (val: number, min: number, max: number) =>
  Math.min(Math.max(val, min), max);

export const fetchAndParse = async <T>(
  kyFetch: () => Promise<unknown>,
  schema: z.ZodSchema<T>,
): Promise<T> => {
  try {
    const rawData = await kyFetch();

    const result = schema.safeParse(rawData);
    if (!result.success) {
      throw new Error(`Invalid API Response: ${z.prettifyError(result.error)}`);
    }
    return result.data;
  } catch (error) {
    console.error(error);
    throw error;
  }
};
