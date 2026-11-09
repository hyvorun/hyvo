// Sourcify, the keyless source of verified contracts for Robinhood Chain (chain 4663). One request answers
// whether a contract is verified, its ABI, and who deployed it. If Sourcify cannot be reached, callers get null
// and the affected check is reported "skipped", never passed.
//
// API v2: GET {base}/v2/contract/{chainId}/{address}?fields=abi,deployment
//   200 -> { match: "exact_match" | "match", abi, deployment: { deployer, transactionHash, blockNumber }, ... }
//   404 -> { match: null, ... } when the contract is not verified.

import type { Address } from "../types.js";
import type { Net } from "../net.js";
import { isAddress, toChecksumAddress } from "./abi.js";

/** The ABI item fields function detection needs. */
export type AbiItem = {
  type: string;
  name?: string;
  inputs?: readonly { type: string }[];
  stateMutability?: string;
};

export interface SourcifyContract {
  /** "full": source and metadata match; "partial": the source matches, the metadata differs; "none": not verified. */
  match: "full" | "partial" | "none";
  abi: AbiItem[] | null;
  deployment: { deployer: Address; transactionHash: string; blockNumber: bigint } | null;
  verifiedAt: string | null;
}

export class SourcifyClient {
  constructor(
    private readonly net: Net,
    private readonly base: string,
    private readonly chainId: number,
  ) {}

  /** Null when Sourcify could not be asked or gave an answer this client does not understand. */
  async contract(address: string): Promise<SourcifyContract | null> {
    try {
      const url = `${this.base.replace(/\/+$/, "")}/v2/contract/${this.chainId}/${address}?fields=abi,deployment`;
      const res = await this.net.request("sourcify", url, { method: "GET", headers: { accept: "application/json" } });
      if (res.status === 404) return { match: "none", abi: null, deployment: null, verifiedAt: null };
      if (res.status !== 200) return null;
      const body = JSON.parse(res.text) as Record<string, unknown>;
      const match = body.match === "exact_match" ? "full" : body.match === "match" ? "partial" : null;
      if (match === null) return body.match === null ? { match: "none", abi: null, deployment: null, verifiedAt: null } : null;
      return {
        match,
        abi: Array.isArray(body.abi) ? (body.abi as AbiItem[]) : null,
        deployment: parseDeployment(body.deployment),
        verifiedAt: typeof body.verifiedAt === "string" ? body.verifiedAt : null,
      };
    } catch {
      return null;
    }
  }
}

function parseDeployment(raw: unknown): SourcifyContract["deployment"] {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.deployer !== "string" || !isAddress(d.deployer)) return null;
  const tx = typeof d.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(d.transactionHash) ? d.transactionHash : null;
  const block = typeof d.blockNumber === "string" && /^\d+$/.test(d.blockNumber) ? BigInt(d.blockNumber) : null;
  if (tx === null || block === null) return null;
  return { deployer: toChecksumAddress(d.deployer), transactionHash: tx, blockNumber: block };
}
