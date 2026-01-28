import { Resource } from "sst";
import { setApiKey, setHost } from "./api/axios.ts";
import { isHexString } from "./utils/hex.ts";
import { invariant } from "./utils/invariant.ts";
import { tryInitWasm } from "./utils/wasm.ts";
import { EXTENDED_API, EXTENDED_VAULT_ID } from "@/constants.ts";

export const init = async () => {
  await tryInitWasm();

  invariant(EXTENDED_API, "API_HOST is not set");
  invariant(Resource.EXTENDED_API_KEY.value, "API_KEY is not set");
  invariant(
    Resource.EXTENDED_STARKEX_KEY.value,
    "STARK_PRIVATE_KEY is not set",
  );
  invariant(EXTENDED_VAULT_ID, "VAULT_ID is not set");
  invariant(
    isHexString(Resource.EXTENDED_STARKEX_KEY.value),
    "STARK_PRIVATE_KEY must be a hex string",
  );

  setHost(EXTENDED_API);
  setApiKey(Resource.EXTENDED_API_KEY.value);

  return {
    apiKey: Resource.EXTENDED_API_KEY.value,
    starkPrivateKey: Resource.EXTENDED_STARKEX_KEY.value,
    vaultId: EXTENDED_VAULT_ID,
  };
};
