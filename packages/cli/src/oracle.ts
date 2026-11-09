// The HyvoOracle contract this build checks runs against. It comes from the repository's deployment record, not
// from the API: an API that could name the contract could point at one of its own that agrees with anything.

import deployment from "../../../chain/deployments/4663.json" with { type: "json" };

export const ORACLE = {
  chainId: deployment.chainId,
  address: deployment.oracle,
  source: "chain/deployments/4663.json in the Hyvo repository",
} as const;
