import { timingSafeEqual } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { LambdaFunctionURLHandler } from "aws-lambda";
import { Resource } from "sst";
import { z } from "zod";

const requestSchema = z.object({
	exchange: z.enum(["extended", "hyperliquid", "risex"]),
});

const workers = {
	extended: Resource.tradeExtended.name,
	hyperliquid: Resource.tradeHyperliquid.name,
	risex: Resource.tradeRisex.name,
} as const;

const lambda = new LambdaClient({});

function isValidKey(value: string | undefined) {
	const expected = Resource.URL_LAMBDA_KEY.value;

	if (!value || value.length !== expected.length) {
		return false;
	}

	return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export const handler: LambdaFunctionURLHandler = async (event) => {
	const authorization =
		event.headers.authorization ?? event.headers.Authorization;

	const key = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: undefined;

	if (!isValidKey(key)) {
		return {
			statusCode: 401,
			body: JSON.stringify({ error: "Unauthorized" }),
		};
	}

	let input: unknown;

	try {
		input = JSON.parse(event.body ?? "{}");
	} catch {
		return {
			statusCode: 400,
			body: JSON.stringify({ error: "Invalid JSON body" }),
		};
	}

	const parsed = requestSchema.safeParse(input);

	if (!parsed.success) {
		return {
			statusCode: 400,
			body: JSON.stringify({
				error: "exchange must be extended, hyperliquid, or risex",
			}),
		};
	}

	await lambda.send(
		new InvokeCommand({
			FunctionName: workers[parsed.data.exchange],
			InvocationType: "Event",
		}),
	);

	return {
		statusCode: 202,
		body: JSON.stringify({ accepted: true, exchange: parsed.data.exchange }),
	};
};
