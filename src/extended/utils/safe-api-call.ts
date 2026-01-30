export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

export const safeApiCall = async <T>(
  apiCall: () => Promise<T>,
  context?: string,
): Promise<ApiResult<T>> => {
  try {
    const data = await apiCall();
    return { success: true, data };
  } catch (error) {
    if (context) {
      console.error(`API call failed (${context}):`, error);
    } else {
      console.error("API call failed:", error);
    }
    return { success: false, error };
  }
};

export const isSuccess = <T>(result: ApiResult<T>): result is { success: true; data: T } => {
  return result.success;
};

export const isError = <T>(result: ApiResult<T>): result is { success: false; error: unknown } => {
  return !result.success;
};
