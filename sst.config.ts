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

    new sst.aws.Function("fetchRW", {
      handler: "src/trade.fetchWeights",
      link: [rwKey],
      url: {
        authorization: "none",
        cors: false,
      },
    });
  },
});
