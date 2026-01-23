import { Resource } from "sst";
import { Handler } from "aws-lambda";
import ky from "ky";
import { EXTENDED_API, ROBOTWEALTH_API } from "./constants";
import { success, z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { Database } from "../database.types.ts";
import { clamp, fetchAndParse } from "./util.ts";

export const tradeYolo: Handler = async () => {
  const config = await getConfig();
  const volAndWeight = await getWeightsAndVolatilities(config);
  const markets = await getMarkets();
  const positions = await getPositions();

  return markets;
};

const Weight = z.object({
  ticker: z.string(),
  arrival_price: z.number(),
  carry_megafactor: z.number(),
  combo_weight: z.number(),
  momentum_megafactor: z.number(),
  trend_megafactor: z.number(),
});

const WeightsSchema = z.object({
  success: z.boolean(),
  last_updated: z.number(),
  data: z.array(Weight),
});

const getWeights = async () =>
  fetchAndParse(
    () =>
      ky
        .get(`${ROBOTWEALTH_API}/weights`, {
          searchParams: {
            api_key: Resource.ROBOTWEALTH_KEY.value,
          },
        })
        .json(),
    WeightsSchema,
  );

const VolSchema = z.object({
  data: z.array(
    z.object({
      date: z.string(),
      ewvol: z.number(),
      ticker: z.string(),
    }),
  ),
  last_updated: z.number(),
  success: z.boolean(),
});

const getVolatilities = async () =>
  fetchAndParse(
    () =>
      ky
        .get(`${ROBOTWEALTH_API}/volatilities`, {
          searchParams: { api_key: Resource.ROBOTWEALTH_KEY.value },
        })
        .json(),
    VolSchema,
  );

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
      dollar_allocation: (m.vol_scaled_weight / totalVol) * config.allocation,
    }));
  else
    return merged.map((m) => ({
      ...m,
      dollar_allocation: m.vol_scaled_weight * config.allocation,
    }));
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

const MarketSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      tradingConfig: z.object({
        minOrderSize: z.number(),
      }),
    }),
  ),
});

const getMarkets = async () =>
  fetchAndParse(
    () => ky.get(`${EXTENDED_API}/v1/info/markets`).json(),
    MarketSchema,
  );

const privateExtended = ky.create({
  headers: {
    "X-Api-Key": Resource.EXTENDED_API_KEY.value,
  },
  prefixUrl: `${EXTENDED_API}/`,
});

const getPositions = async () => {
  try {
    const data = await privateExtended.get("v1/user/positions").json();
    return data;
  } catch (e) {
    console.error(e);
  }
};
