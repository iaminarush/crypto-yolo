import { Resource } from "sst";

export async function fetchWeights() {
  const url = new URL("https://api.robotwealth.com/v1/yolo/weights");
  const params = new URLSearchParams();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}
