import type { Handler } from "aws-lambda";
import { getConfig, getWeightsAndVolatilities } from "./api";

export const handler: Handler = async () => {
  const config = await getConfig("risex");
  const volAndWeight = await getWeightsAndVolatilities(config);

  console.log(volAndWeight);
};

const calculateDesiredPositions = () => {};
