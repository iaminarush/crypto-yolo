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

export const getRandomInt = (min: number, max: number) => {
  return Math.floor(Math.random() * (max - min)) + min;
};

export const generateNonce = () => {
  return getRandomInt(0, 2 ** 31 - 1).toString();
};

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;

  const err = error as {
    message?: string;
    cause?: { code?: string; name?: string };
  };

  const message = err.message?.toLowerCase() ?? "";
  const causeCode = err.cause?.code;
  const causeName = err.cause?.name;

  return (
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("network") ||
    causeCode === "ECONNREFUSED" ||
    causeCode === "ETIMEDOUT" ||
    causeName === "TimeoutError" ||
    causeName === "AbortError"
  );
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) {
        console.error(`Failed after ${maxRetries} attempts:`, error);
        throw error;
      }

      if (isRetryableError(error)) {
        const delay = baseDelayMs * 2 ** i;
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error("Unreachable");
}
