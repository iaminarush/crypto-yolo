import { Resource } from "sst";
import { Handler } from "aws-lambda";
import ky from "ky";
import { EXTENDED_API, ROBOTWEALTH_API } from "./constants";
import { success, z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { Database } from "../database.types.ts";
import { clamp } from "./util.ts";

export const tradeYolo: Handler = async () => {
  const config = await getConfig();
  const volAndWeight = await getWeightsAndVolatilities(config);

  return volAndWeight;
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
    .get(`${ROBOTWEALTH_API}/weights`, {
      searchParams: { api_key: Resource.ROBOTWEALTH_KEY.value },
    })
    .json();

  const result = WeightsResponse.safeParse(rawData);

  if (!result.success) {
    throw new Error(`Invalid API Response: ${z.treeifyError(result.error)}`);
  }

  return result.data;
};

const VolSchema = z.object({
  date: z.string(),
  ewvol: z.number(),
  ticker: z.string(),
});

const VolResponse = z.object({
  data: z.array(VolSchema),
  last_updated: z.number(),
  success: z.boolean(),
});

export const getVolatilities = async () => {
  const rawData = await ky
    .get(`${ROBOTWEALTH_API}/volatilities`, {
      searchParams: { api_key: Resource.ROBOTWEALTH_KEY.value },
    })
    .json();

  const result = VolResponse.safeParse(rawData);

  if (!result.success) {
    throw new Error(`Invalid API Resposne: ${z.treeifyError(result.error)} `);
  }

  return result.data;
};

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];

const getWeightsAndVolatilities = async (config: TConfig) => {
  const weights = await getWeights();
  const volatilities = await getVolatilities();
  let totalVol = 0;

  const merged = weights.data.map((w) => {
    const vol = volatilities.data.find((v) => v.ticker === w.ticker);
    if (!vol)
      throw new Error("Non matching ticker between weights and volatilities");

    if (vol.ewvol <= 0)
      throw new Error(`Vol for ${vol.ticker} must be greather than 0`);

    const inverseVol = 1 / vol.ewvol;
    const comboWeight =
      w.trend_megafactor * config.trend_weight +
      w.momentum_megafactor * config.momentum_weight +
      w.carry_megafactor * config.carry_weight;

    const volScaledWeight = clamp(inverseVol * comboWeight, -0.25, 0.25);

    totalVol += Math.abs(volScaledWeight);

    return {
      ...w,
      ewvol: vol.ewvol,
      inverseVol,
      combo_weight: comboWeight,
      vol_scaled_weight: volScaledWeight,
    };
  });

  if (totalVol > 1)
    return merged.map((m) => ({
      ...m,
      vol_scaled_weight: m.vol_scaled_weight / totalVol,
    }));
  else return merged;
};

const supabaseUrl = "https://lapkwtulywsjfjogngcx.supabase.co";
const supabaseKey = Resource.SUPABASE_KEY.value;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

export const getConfig = async () => {
  const { data, error } = await supabase
    .from("exchange")
    .select()
    .eq("exchange", "extended")
    .single();

  if (!data) throw new Error("No exchange config in DB");

  if (data.carry_weight + data.momentum_weight + data.trend_weight !== 1)
    throw new Error("Config weights does not add up to 1");

  return data;
};

const getMarkets = async () => {
  const data = await ky.get(`${EXTENDED_API}/api/v1/info/markets`).json();

  return data;
};
