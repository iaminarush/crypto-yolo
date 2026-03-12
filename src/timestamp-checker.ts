import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createClient } from "@supabase/supabase-js";
import ky from "ky";
import { Resource } from "sst";
import { z } from "zod";
import type { Database } from "../database.types.ts";
import { ROBOTWEALTH_API, SUPABASE_URL, TIMESTAMP_ID } from "./constants.ts";

const supabaseUrl = SUPABASE_URL;
const supabaseKey = Resource.SUPABASE_KEY.value;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

const WeightsSchema = z.object({
  success: z.boolean(),
  last_updated: z.number(),
  data: z.array(z.unknown()),
});

const VolSchema = z.object({
  success: z.boolean(),
  last_updated: z.number(),
  data: z.array(z.unknown()),
});

const getWeights = async () => {
  const response = await ky
    .get(`${ROBOTWEALTH_API}/weights`, {
      searchParams: {
        api_key: Resource.ROBOTWEALTH_KEY.value,
      },
    })
    .json();

  return WeightsSchema.parse(response);
};

const getVolatilities = async () => {
  const response = await ky
    .get(`${ROBOTWEALTH_API}/volatilities`, {
      searchParams: {
        api_key: Resource.ROBOTWEALTH_KEY.value,
      },
    })
    .json();

  return VolSchema.parse(response);
};

const getStoredTimestamp = async () => {
  const { data } = await supabase
    .from("timestamp")
    .select("*")
    .eq("id", TIMESTAMP_ID)
    .single();

  if (!data) {
    const result = await supabase
      .from("timestamp")
      .upsert({ id: TIMESTAMP_ID, timestamp: 0 })
      .select()
      .single();

    return {
      lastTriggeredTimestamp: result.data?.timestamp || 0,
    };
  }

  return {
    lastTriggeredTimestamp: data.timestamp,
  };
};

const getToday9AMUTC = () => {
  const now = new Date();
  const today9AM = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    9,
    0,
    0,
  );
  return Math.floor(today9AM / 1000);
};

const updateLastTriggered = async (timestamp: number) => {
  await supabase
    .from("timestamp")
    .upsert({ id: TIMESTAMP_ID, timestamp })
    .eq("id", TIMESTAMP_ID);
};

export const handler = async () => {
  const weights = await getWeights();
  const volatilities = await getVolatilities();

  const weightsTimestamp = weights.last_updated;
  const volatilitiesTimestamp = volatilities.last_updated;

  const stored = await getStoredTimestamp();

  const today9AM = getToday9AMUTC();

  const notTriggeredToday = stored.lastTriggeredTimestamp < today9AM;
  const weightsUpdatedToday = weightsTimestamp >= today9AM;
  const volUpdatedToday = volatilitiesTimestamp >= today9AM;

  const shouldTrigger =
    notTriggeredToday && weightsUpdatedToday && volUpdatedToday;

  if (shouldTrigger) {
    const client = new LambdaClient({ region: "ap-northeast-1" });
    await client.send(
      new InvokeCommand({
        FunctionName: Resource.tradeExtended.name,
        InvocationType: "Event",
      }),
    );

    const nowTimestamp = Math.floor(Date.now() / 1000);
    await updateLastTriggered(nowTimestamp);

    return {
      triggered: true,
      weightsTimestamp,
      volatilitiesTimestamp,
    };
  }

  return {
    triggered: false,
    notTriggeredToday,
    weightsUpdatedToday,
    volUpdatedToday,
    weightsTimestamp,
    volatilitiesTimestamp,
    storedLastTriggered: stored.lastTriggeredTimestamp,
    today9AM,
  };
};
