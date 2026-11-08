/**
 * Paying through PaymentRouter from the wallet: approve exactly the amount, then `pay`, which sends it to the treasury in the
 * same call. Hyvo never holds the tokens. A run's order and a balance's top-up pay the same way.
 */
import type { Address, Hex } from "viem";
import { getChainId, readContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CHAIN_ID, ERC20_ABI, ROUTER_ABI } from "./chain";
import { formatTokenAmount } from "./draft";
import { wagmiConfig } from "./wallet";

export interface Payment {
  orderId: string;
  account: Address;
  token: { address: string; symbol: string; decimals: number };
  router: string;
  amount: string;
  /** Finishes "the wallet holds x; ... costs y": "the run", "this top-up". */
  what: string;
}

/** Returns the payment's transaction once it is mined. `onSent` fires as soon as it is sent. */
export async function payThroughRouter(
  payment: Payment,
  on: { stage: (text: string, tx?: Hex) => void; sent: (tx: Hex) => void },
): Promise<Hex> {
  const token = payment.token.address as Address;
  const router = payment.router as Address;
  const amount = BigInt(payment.amount);
  const shown = `${formatTokenAmount(payment.amount, payment.token.decimals)} ${payment.token.symbol}`;
  if (getChainId(wagmiConfig) !== CHAIN_ID) {
    on.stage("Switching your wallet to Robinhood Chain…");
    await switchChain(wagmiConfig, { chainId: CHAIN_ID });
  }
  const balance = await readContract(wagmiConfig, { address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [payment.account] });
  if (balance < amount) {
    const have = formatTokenAmount(balance.toString(), payment.token.decimals);
    throw new Error(`This wallet holds ${have} ${payment.token.symbol}; ${payment.what} costs ${shown}.`);
  }
  const allowance = await readContract(wagmiConfig, {
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [payment.account, router],
  });
  if (allowance < amount) {
    on.stage(`Approve exactly ${shown} in your wallet…`);
    const approval = await writeContract(wagmiConfig, { address: token, abi: ERC20_ABI, functionName: "approve", args: [router, amount], chainId: CHAIN_ID });
    on.stage("Waiting for the approval to confirm…", approval);
    await waitForTransactionReceipt(wagmiConfig, { hash: approval, chainId: CHAIN_ID });
  }
  on.stage("Confirm the payment in your wallet…");
  const tx = await writeContract(wagmiConfig, {
    address: router,
    abi: ROUTER_ABI,
    functionName: "pay",
    args: [payment.orderId as Hex, token, amount],
    chainId: CHAIN_ID,
  });
  on.sent(tx);
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: tx, chainId: CHAIN_ID });
  if (receipt.status !== "success") throw new Error("The payment transaction reverted; nothing was paid.");
  return tx;
}
