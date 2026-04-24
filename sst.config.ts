/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "extended-yolo",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      providers: {
        aws: {
          profile: "admin",
        },
      },
    };
  },
  async run() {
    const rwKey = new sst.Secret("ROBOTWEALTH_KEY");
    const supabaseKey = new sst.Secret("SUPABASE_KEY");
    const extendedApiKey = new sst.Secret("EXTENDED_API_KEY");
    const extendedStarkexKey = new sst.Secret("EXTENDED_STARKEX_KEY");
    const telegramToken = new sst.Secret("TELEGRAM_TOKEN");
    const telegramId = new sst.Secret("TELEGRAM_ID");
    const extendedLambdaKey = new sst.Secret("EXTENDED_LAMBDA_KEY");

    const hyperliquidWallet = new sst.Secret("HYPERLIQUID_WALLET");
    const hyperliquidKey = new sst.Secret("HYPERLIQUID_KEY");

    const errorTopic = new sst.aws.SnsTopic("FailureTopic");

    const stage = $app.stage;

    const notifier = new sst.aws.Function("notifier", {
      handler: "src/notifier.handler",
      link: [telegramToken, telegramId],
      runtime: "nodejs24.x",
    });

    errorTopic.subscribe("FailureSubscriber", notifier.arn);

    const extendedWorker = new sst.aws.Function("tradeExtended", {
      handler: "src/trade-extended.handler",
      link: [
        rwKey,
        supabaseKey,
        extendedApiKey,
        extendedStarkexKey,
        telegramToken,
        telegramId,
        extendedLambdaKey,
      ],
      timeout: "15 minutes",
      runtime: "nodejs24.x",
      nodejs: { install: ["@x10xchange/stark-crypto-wrapper-wasm"] },
    });

    const hyperliquidWorker = new sst.aws.Function("tradeHyperliquid", {
      handler: "src/trade-hyperliquid.handler",
      link: [
        rwKey,
        supabaseKey,
        telegramToken,
        telegramId,
        hyperliquidWallet,
        hyperliquidKey,
      ],
      timeout: "15 minutes",
      runtime: "nodejs24.x",
    });

    new aws.cloudwatch.MetricAlarm("WorkerErrorAlarm", {
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      evaluationPeriods: 1,
      metricName: "Errors",
      namespace: "AWS/Lambda",
      period: 60,
      statistic: "Sum",
      threshold: 1,
      treatMissingData: "notBreaching",
      alarmActions: [errorTopic.arn],
      dimensions: {
        FunctionName: extendedWorker.name,
      },
    });

    const timestampChecker = new sst.aws.Function("TimestampChecker", {
      handler: "src/timestamp-checker.handler",
      link: [rwKey, supabaseKey, extendedWorker, hyperliquidWorker],
      runtime: "nodejs24.x",
    });

    new sst.aws.CronV2("TimestampCheck", {
      schedule: "cron(5-30/5 9 * * ? *)",
      job: timestampChecker.arn,
      enabled: stage !== "dev",
    });
  },
});
