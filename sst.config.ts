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

    const errorTopic = new sst.aws.SnsTopic("FailureTopic");

    const notifier = new sst.aws.Function("notifier", {
      handler: "src/notifier.handler",
      link: [telegramToken, telegramId],
    });

    errorTopic.subscribe("FailureSubscriber", notifier.arn);

    const tradeWorker = new sst.aws.Function("tradeYolo", {
      handler: "src/trade.tradeYolo",
      link: [
        rwKey,
        supabaseKey,
        extendedApiKey,
        extendedStarkexKey,
        telegramToken,
        telegramId,
      ],
      timeout: "15 minutes",
      url: {
        cors: false,
      },
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
        FunctionName: tradeWorker.name,
      },
    });

    const weightChecker = new sst.aws.Function("weightChecker", {
      handler: "src/weight-checker.handler",
      link: [rwKey, supabaseKey, tradeWorker],
    });

    new sst.aws.Cron("WeightCheck", {
      schedule: "cron(5-20 9 * * ? *)",
      job: weightChecker.arn,
    });
  },
});
