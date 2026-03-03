import { createClient } from "@supabase/supabase-js";
import { Resource } from "sst";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import ky from "ky";
import { z } from "zod";
import { Database } from "../database.types.ts";
import { ROBOTWEALTH_API } from "./constants";

const supabaseUrl = "https://lapkwtulywsjfjogngcx.supabase.co";
const supabaseKey = Resource.SUPABASE_KEY.value;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

const WeightsSchema = z.object({
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

const getStoredTimestamp = async () => {
  const { data } = await supabase
    .from("exchange")
    .select("timestamp")
    .eq("exchange", "extended")
    .single();

  return data?.timestamp ?? 0;
};

const updateTimestamp = async (timestamp: number) => {
  await supabase
    .from("exchange")
    .update({ timestamp })
    .eq("exchange", "extended");
};

export const handler = async () => {
  const weights = await getWeights();
  const apiTimestamp = weights.last_updated;
  const storedTimestamp = await getStoredTimestamp();

  if (apiTimestamp > storedTimestamp) {
    const client = new LambdaClient({ region: "ap-northeast-1" });
    await client.send(
      new InvokeCommand({
        FunctionName: Resource.tradeYolo.name,
        InvocationType: "Event",
      }),
    );

    await updateTimestamp(apiTimestamp);

    return {
      triggered: true,
      apiTimestamp,
      storedTimestamp,
    };
  }

  return {
    triggered: false,
    apiTimestamp,
    storedTimestamp,
  };
};
