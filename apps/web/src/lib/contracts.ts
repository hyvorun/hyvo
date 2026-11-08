/**
 * What /trust reads from the chain itself: who owns HyvoOracle and PaymentRouter, who may commit,
 * where payments go, and what the router holds. Every read is pinned to one block, so the answers
 * fit together.
 */
import { formatUnits, parseAbi, zeroAddress, type Address } from "viem";
import { ADDRESSES } from "./addresses";
import { publicClient } from "./chain";

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function attester() view returns (address)",
  "function treasury() view returns (address)",
  "function allowedToken(address token) view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export interface Ownership {
  owner: Address;
  /** Set while ownership is being handed over and the new owner has not accepted yet. */
  pendingOwner: Address | null;
}

export interface ChainFacts {
  block: bigint;
  oracle: (Ownership & { address: Address; attester: Address }) | null;
  router:
    | (Ownership & {
        address: Address;
        treasury: Address;
        ethHeld: string;
        /** The router's USDG: whether it is accepted, and how much the contract itself holds. */
        usdg: { symbol: string; accepted: boolean; held: string } | null;
      })
    | null;
}

async function ownership(address: Address, blockNumber: bigint): Promise<Ownership> {
  const client = publicClient();
  const [owner, pendingOwner] = await Promise.all([
    client.readContract({ address, abi: ABI, functionName: "owner", blockNumber }),
    client.readContract({ address, abi: ABI, functionName: "pendingOwner", blockNumber }),
  ]);
  return { owner, pendingOwner: pendingOwner === zeroAddress ? null : pendingOwner };
}

export async function readChainFacts(): Promise<ChainFacts> {
  const client = publicClient();
  const block = await client.getBlockNumber();

  const readOracle = async () => {
    if (!ADDRESSES.oracle) return null;
    const address = ADDRESSES.oracle as Address;
    const [owned, attester] = await Promise.all([
      ownership(address, block),
      client.readContract({ address, abi: ABI, functionName: "attester", blockNumber: block }),
    ]);
    return { address, attester, ...owned };
  };

  const readRouter = async () => {
    if (!ADDRESSES.paymentRouter) return null;
    const address = ADDRESSES.paymentRouter as Address;
    const usdgAddress = ADDRESSES.usdg as Address | "";
    const [owned, treasury, eth, usdg] = await Promise.all([
      ownership(address, block),
      client.readContract({ address, abi: ABI, functionName: "treasury", blockNumber: block }),
      client.getBalance({ address, blockNumber: block }),
      usdgAddress
        ? Promise.all([
            client.readContract({ address: usdgAddress, abi: ABI, functionName: "symbol", blockNumber: block }),
            client.readContract({ address: usdgAddress, abi: ABI, functionName: "decimals", blockNumber: block }),
            client.readContract({ address: usdgAddress, abi: ABI, functionName: "balanceOf", args: [address], blockNumber: block }),
            client.readContract({ address, abi: ABI, functionName: "allowedToken", args: [usdgAddress], blockNumber: block }),
          ]).then(([symbol, decimals, held, accepted]) => ({ symbol, accepted, held: formatUnits(held, decimals) }))
        : Promise.resolve(null),
    ]);
    return { address, treasury, ethHeld: formatUnits(eth, 18), usdg, ...owned };
  };

  const [oracle, router] = await Promise.all([readOracle(), readRouter()]);
  return { block, oracle, router };
}
