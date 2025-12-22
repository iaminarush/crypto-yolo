import { Resource } from "sst";
import { Handler } from "aws-lambda";

export const fetchWeights: Handler = async () => {
  const url = new URL("https://api.robotwealth.com/v1/yolo/weights");
  const params = new URLSearchParams();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
};
