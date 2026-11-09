import type { Finding } from "../types.js";
import type { CheckContext } from "./context.js";
import { type FunctionCategory, powerFinding } from "./detect.js";

export const BLOCKLIST: FunctionCategory = {
  signatures: [
    "blacklist(address)",
    "blacklist(address,bool)",
    "setBlacklist(address,bool)",
    "addBlacklist(address)",
    "setBlocked(address,bool)",
    "setBlock(address,bool)",
    "ban(address)",
    "freeze(address)",
  ],
  // excludeFrom* (excludeFromFee, excludeFromReward) is deliberately NOT matched: it is common in reflection
  // tokens and a known false positive. freeze counts only with an address argument (freeze() alone is often a
  // metadata lock).
  abiName: /^(blacklist|setblacklist|addblacklist|setblocked|setblock|ban|freeze)$/i,
  inputs: (inputs) => inputs.some((i) => i.type === "address"),
  describe: "blacklist, setBlacklist, addBlacklist, setBlocked, setBlock, ban or freeze (with an address)",
};

/** A blocklist lets its holder stop given addresses from moving the token. */
export function blacklistCheck(ctx: CheckContext): Finding {
  return powerFinding("blocklist", ctx, BLOCKLIST);
}
