import type { Finding } from "../types.js";
import type { CheckContext } from "./context.js";
import { type FunctionCategory, powerFinding } from "./detect.js";

export const MINT: FunctionCategory = {
  // increaseSupply(uint256) and increaseSupplyToAddress(uint256,address) are how Paxos-style supply controllers
  // mint (USDG's implementation has both).
  signatures: [
    "mint(address,uint256)",
    "mint(uint256)",
    "mint(address)",
    "mintTo(address,uint256)",
    "increaseSupply(uint256)",
    "increaseSupplyToAddress(uint256,address)",
  ],
  // Anchored so it matches mint / mintTo / mintBatch but NOT minter, mintable or mintingFinished, which are
  // getters (known false positives).
  abiName: /^(_?mint([A-Z_]|$)|increaseSupply([A-Z]|$))/,
  describe: "mint, mintTo or increaseSupply",
};

/** A callable mint lets its holder create new supply. */
export function mintCheck(ctx: CheckContext): Finding {
  return powerFinding("mint", ctx, MINT);
}
