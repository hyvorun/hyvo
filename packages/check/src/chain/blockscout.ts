// Blockscout's keyed API, optional. robinhoodchain.blockscout.com answers programs with a bot challenge, and the
// keyed API (api.blockscout.com/4663/api) needs a free key from dev.blockscout.com: without one it answers 402
// (docs/OPEN_ITEMS.md item 24). With no key, Hyvo Check does not call Blockscout at all: the holder check is
// skipped, and Sourcify alone answers for verified source and the deployer.
//
// The routes are Blockscout's standard v2 API. They have not been tried on the keyed host yet, for want of a
// key; every method returns null on any failure, and the affected check is then reported "skipped".

import type { Address } from "../types.js";
import type { Net } from "../net.js";
import { isAddress, toChecksumAddress } from "./abi.js";
import type { AbiItem } from "./sourcify.js";

export type BlockscoutContract = { verified: boolean; abi: AbiItem[] | null };

export class BlockscoutClient {
  constructor(
    private readonly net: Net,
    private readonly apiBase: string, // e.g. https://api.blockscout.com/4663/api
    private readonly apiKey: string,
  ) {}

  // Returns the HTTP status and parsed body; one retry after a 429. Throws on a network failure.
  private async request(path: string): Promise<{ status: number; json: unknown }> {
    const url = `${this.apiBase.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(this.apiKey)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.net.request("blockscout", url, { method: "GET", headers: { accept: "application/json" } });
      if (res.status === 429 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      let json: unknown = null;
      try {
        json = JSON.parse(res.text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
  }

  /** Verification status and ABI; 404 means not verified. Null when Blockscout could not be asked. */
  async getContract(address: string): Promise<BlockscoutContract | null> {
    try {
      const { status, json } = await this.request(`/v2/smart-contracts/${address}`);
      if (status === 404) return { verified: false, abi: null };
      if (status === 200 && json && typeof json === "object") {
        const obj = json as Record<string, unknown>;
        const verified = Boolean(obj.is_verified ?? obj.abi ?? obj.source_code);
        const abi = Array.isArray(obj.abi) ? (obj.abi as AbiItem[]) : null;
        return { verified, abi };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Token totals. Null on failure. */
  async getTokenInfo(address: string): Promise<{ totalSupply: bigint | null; holders: number | null } | null> {
    try {
      const { status, json } = await this.request(`/v2/tokens/${address}`);
      if (status !== 200 || !json || typeof json !== "object") return null;
      const o = json as Record<string, unknown>;
      const holders = o.holders ?? o.holders_count;
      return {
        totalSupply: typeof o.total_supply === "string" && /^\d+$/.test(o.total_supply) ? BigInt(o.total_supply) : null,
        holders: holders != null && Number.isFinite(Number(holders)) ? Number(holders) : null,
      };
    } catch {
      return null;
    }
  }

  /** The largest holders, balance-descending (Blockscout's first page). Null on failure. */
  async getTokenHolders(address: string): Promise<{ address: Address; value: bigint }[] | null> {
    try {
      const { status, json } = await this.request(`/v2/tokens/${address}/holders`);
      if (status !== 200 || !json || typeof json !== "object") return null;
      const items = (json as Record<string, unknown>).items;
      if (!Array.isArray(items)) return null;
      const out: { address: Address; value: bigint }[] = [];
      for (const it of items) {
        const row = it as Record<string, unknown>;
        const hash = (row.address as Record<string, unknown> | undefined)?.hash;
        if (typeof hash !== "string" || !isAddress(hash)) continue;
        if (typeof row.value !== "string" || !/^\d+$/.test(row.value)) continue;
        out.push({ address: toChecksumAddress(hash), value: BigInt(row.value) });
      }
      return out;
    } catch {
      return null;
    }
  }

  /** The address that created the contract, and the creation transaction. Null on failure. */
  async getCreator(address: string): Promise<{ deployer: Address; creationTxHash: string | null } | null> {
    try {
      const { status, json } = await this.request(`/v2/addresses/${address}`);
      if (status !== 200 || !json || typeof json !== "object") return null;
      const o = json as Record<string, unknown>;
      const creator = o.creator_address_hash;
      if (typeof creator !== "string" || !isAddress(creator)) return null;
      return {
        deployer: toChecksumAddress(creator),
        creationTxHash: typeof o.creation_transaction_hash === "string" ? o.creation_transaction_hash : null,
      };
    } catch {
      return null;
    }
  }
}
