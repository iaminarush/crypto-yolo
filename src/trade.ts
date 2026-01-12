import { Resource } from "sst";
import { Handler } from "aws-lambda";
import ky from "ky";
import { EXTENDED_API } from "./constants";
import { success, z } from "zod";
import { createClient } from "@supabase/supabase-js";

export const tradeYolo: Handler = async () => {
  const weights = await getWeights();

  await getTimestamp();

  return weights;
};

const Weight = z.object({
  ticker: z.string(),
  arrival_price: z.number(),
  carry_megafactor: z.number(),
  combo_weight: z.number(),
  momentum_megafactor: z.number(),
  trend_megafactor: z.number(),
});

const WeightsResponse = z.object({
  success: z.boolean(),
  last_updated: z.number(),
  data: z.array(Weight),
});

export const getWeights = async () => {
  const rawData = await ky
    .get("https://api.robotwealth.com/v1/yolo/weights", {
      searchParams: { api_key: Resource.ROBOTWEALTH_KEY.value },
    })
    .json();

  const result = WeightsResponse.safeParse(rawData);

  if (!result.success) {
    console.error("Invalid API response:", z.treeifyError(result.error));
    return null;
  }

  return result.data;
};

const supabaseUrl = "https://lapkwtulywsjfjogngcx.supabase.co";
const supabaseKey = Resource.SUPABASE_KEY.value;
const supabase = createClient(supabaseUrl, supabaseKey);

export const getTimestamp = async () => {
  const { data, error } = await supabase.from("timestamp").select("*");

  console.log(data);
};

const getMarkets = async () => {
  const data = await ky.get(`${EXTENDED_API}/api/v1/info/markets`).json();

  return data;
};
