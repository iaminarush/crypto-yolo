import { Resource } from "sst";
import { Handler } from "aws-lambda";

export const fetchWeights: Handler = async () => {
  const url = new URL("https://api.robotwealth.com/v1/yolo/weights");

  url.searchParams.append("api_key", Resource.ROBOTWEALTH_KEY.value);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return data;
};
