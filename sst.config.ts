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

    new sst.aws.Function("tradeYolo", {
      handler: "src/trade.tradeYolo",
      link: [rwKey, supabaseKey],
      url: {
        cors: false,
      },
    });
  },
});
