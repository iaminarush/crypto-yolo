import { Handler } from "aws-lambda";
import { Effect, Layer } from "effect";
import { TradingConfigService } from "./effect-services";

const AppLayer = Layer.mergeAll(TradingConfigService.layer);

const program = Effect.gen(function* () {});

export const handler: Handler = () => Effect.runPromise(program.pipe(Effect.provide(AppLayer)));
