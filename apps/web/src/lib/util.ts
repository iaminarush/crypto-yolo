import { createClient } from "@supabase/supabase-js";
import BigNumber from "bignumber.js";
import ky from "ky";
import z from "zod";
import { ROBOTWEALTH_API, SUPABASE_URL } from "./constants";
import type { Database } from "./database.types";
import { env } from "./env";

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

const supabaseUrl = SUPABASE_URL;
const supabaseKey = env.SUPABASE_KEY;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

type TExchangeNames = "extended" | "hyperliquid" | "risex";

export const getConfig = async (exchange: TExchangeNames) => {
	const { data } = await supabase
		.from("exchange")
		.select()
		.eq("exchange", exchange)
		.single();

	if (!data) throw new Error("No exchange config in DB");

	if (data.carry_weight + data.momentum_weight + data.trend_weight !== 1)
		throw new Error("Config weights does not add up to 1");

	return data;
};

type TConfig = Database["public"]["Tables"]["exchange"]["Row"];

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

export const getWeights = async () =>
	fetchAndParse(
		() =>
			ky
				.get(`${ROBOTWEALTH_API}/weights`, {
					searchParams: {
						api_key: env.RW_KEY,
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
					searchParams: { api_key: env.RW_KEY },
				})
				.json(),
		VolSchema,
	);

export const getTickers = async () => {
	const { data } = await supabase.from("ticker").select();

	if (!data) throw new Error("No exchange config in DB");

	return data;
};

export const getWeightsAndVolatilities = async (config: TConfig) => {
	const weights = await getWeights();
	const volatilities = await getVolatilities();
	let totalVol = new BigNumber(0);

	const merged = weights.data.map((w) => {
		const vol = volatilities.data.find((v) => v.ticker === w.ticker);
		if (!vol)
			throw new Error("Non matching ticker between weights and volatilities");

		if (vol.ewvol <= 0)
			throw new Error(`Vol for ${vol.ticker} must be greather than 0`);

		const inverseVol = new BigNumber(1).div(vol.ewvol);
		const comboWeight = new BigNumber(w.trend_megafactor)
			.times(config.trend_weight)
			.plus(new BigNumber(w.momentum_megafactor).times(config.momentum_weight))
			.plus(new BigNumber(w.carry_megafactor).times(config.carry_weight));

		const volScaledWeight = BigNumber(
			clamp(inverseVol.times(comboWeight).toNumber(), -0.25, 0.25),
		);

		// totalVol = totalVol.plus(Math.abs(volScaledWeight.toNumber()));
		totalVol = totalVol.plus(volScaledWeight.abs());

		return {
			...w,
			ewvol: vol.ewvol,
			inverseVol,
			combo_weight: comboWeight,
			vol_scaled_weight: volScaledWeight,
		};
	});

	if (totalVol.gt(1))
		return merged.map((m) => {
			const volScaledWeight = new BigNumber(m.vol_scaled_weight).div(totalVol);
			const dollarAllocation = volScaledWeight.times(config.allocation);

			return {
				ticker: m.ticker,
				token_allocation: dollarAllocation.div(m.arrival_price),
			};
		});
	else
		return merged.map((m) => {
			const dollarAllocation = new BigNumber(m.vol_scaled_weight).times(
				config.allocation,
			);
			return {
				ticker: m.ticker,
				token_allocation: dollarAllocation.div(m.arrival_price),
			};
		});
};
