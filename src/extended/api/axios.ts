import axios, { AxiosError } from "axios";

import { parseJsonWithBigNumber } from "../utils/json.ts";

const safeParseResponse = (data: unknown) => {
  if (!data || typeof data !== "string") {
    return undefined;
  }

  try {
    return parseJsonWithBigNumber(data);
  } catch {
    return undefined;
  }
};

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 250;
const RETRY_MULTIPLIER = 2;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const calculateDelay = (attempt: number): number => {
  return INITIAL_RETRY_DELAY_MS * Math.pow(RETRY_MULTIPLIER, attempt - 1);
};

const isRetryableError = (error: AxiosError): boolean => {
  if (!error.response) {
    // Network errors (no response)
    return true;
  }

  const status = error.response.status;
  // Retry on 5xx server errors and 429 rate limit
  return status >= 500 || status === 429;
};

export const axiosClient = axios.create({
  paramsSerializer: {
    indexes: null,
  },
});

// Request interceptor to track retry count
axiosClient.interceptors.request.use((config) => {
  config.headers['x-retry-count'] = config.headers['x-retry-count'] || 0;
  return config;
});

// Response interceptor with retry logic
axiosClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    if (!axios.isAxiosError(error)) {
      return Promise.reject(error);
    }

    const config = error.config;
    if (!config) {
      return Promise.reject(error);
    }

    const retryCount = Number(config.headers['x-retry-count']) || 0;

    if (retryCount < MAX_RETRIES && isRetryableError(error)) {
      const delay = calculateDelay(retryCount + 1);
      console.warn(`Request failed (${error.response?.status || 'network error'}), retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
      
      await sleep(delay);
      
      config.headers['x-retry-count'] = retryCount + 1;
      return axiosClient(config);
    }

    // Max retries exceeded or non-retryable error
    return Promise.reject({
      url: error.response?.config.url,
      status: error.response?.status,
      data: error.response?.data,
    });
  },
);

axiosClient.defaults.transformResponse = [safeParseResponse];

export const setHost = (baseUrl: string) => {
  axiosClient.defaults.baseURL = baseUrl;
};

export const setApiKey = (apiKey: string) => {
  axiosClient.defaults.headers.common["x-api-key"] = apiKey;
};
