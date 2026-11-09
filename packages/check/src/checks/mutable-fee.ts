import type { Finding } from "../types.js";
import type { CheckContext } from "./context.js";
import { type FunctionCategory, powerFinding } from "./detect.js";

export const FEE_SETTER: FunctionCategory = {
  signatures: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTax(uint256)",
    "setTaxes(uint256,uint256)",
    "updateFee(uint256)",
    "updateFees(uint256,uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
  ],
  // Anchored to fee and tax RATE setters. setFeeRecipient / setFeeWallet change where fees go, not the rate,
  // and are left out (known false positives).
  abiName: /^(set|update)(fee|fees|tax|taxes|buytax|selltax|buyfee|sellfee)(percent|s)?$/i,
  describe: "setFee, setFees, setTax, setTaxes, updateFee(s), setBuyTax or setSellTax",
};

/** A fee or tax rate that can be changed after launch. */
export function mutableFeeCheck(ctx: CheckContext): Finding {
  return powerFinding("fee-setter", ctx, FEE_SETTER);
}
