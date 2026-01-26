import { Resource } from "sst";
import { Handler } from "aws-lambda";
import ky from "ky";
import { EXTENDED_API, ROBOTWEALTH_API } from "./constants";
import { success, z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { Database } from "../database.types.ts";
import { clamp, fetchAndParse } from "./util.ts";
import Decimal from "decimal.js";

export const tradeYolo: Handler = async () => {
  const config = await getConfig();
  const volAndWeight = await getWeightsAndVolatilities(config);
  const tickers = await getTickers();

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
  let totalVol = new Decimal(0);

  const merged = weights.data.map((w) => {
    const vol = volatilities.data.find((v) => v.ticker === w.ticker);
    if (!vol)
      throw new Error("Non matching ticker between weights and volatilities");

    if (vol.ewvol <= 0)
      throw new Error(`Vol for ${vol.ticker} must be greather than 0`);

    const inverseVol = new Decimal(1).dividedBy(vol.ewvol);
    const comboWeight = new Decimal(w.trend_megafactor)
      .times(config.trend_weight)
      .plus(new Decimal(w.momentum_megafactor).times(config.momentum_weight))
      .plus(new Decimal(w.carry_megafactor).times(config.carry_weight));

    const volScaledWeight = clamp(
      new Decimal(inverseVol).times(comboWeight).toNumber(),
      -0.25,
      0.25,
    );

    totalVol = totalVol.plus(Math.abs(volScaledWeight));

    return {
      ...w,
      ewvol: vol.ewvol,
      inverseVol,
      combo_weight: comboWeight,
      vol_scaled_weight: volScaledWeight,
    };
  });

  if (totalVol.greaterThan(1))
    return merged.map((m) => {
      const volScaledWeight = new Decimal(m.vol_scaled_weight).dividedBy(
        totalVol,
      );
      const dollarAllocation = volScaledWeight.times(config.allocation);

      return {
        ...m,
        vol_scaled_weight: volScaledWeight.toNumber(),
        dollar_allocation: dollarAllocation.toNumber(),
        token_allocation: dollarAllocation.dividedBy(m.arrival_price),
      };
    });
  else
    return merged.map((m) => {
      const dollarAllocation = new Decimal(m.vol_scaled_weight).times(
        config.allocation,
      );
      return {
        ...m,
        dollar_allocation: dollarAllocation,
      };
    });
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

export const getTickers = async () => {
  const { data, error } = await supabase.from("ticker").select();

  if (!data) throw new Error("No exchange config in DB");

  return data;
};
