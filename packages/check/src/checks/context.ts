import type { AbiItem } from "../chain/sourcify.js";
import type { Address, Hex } from "../types.js";

export type OwnerState = {
  // "active": owner() or getOwner() returns an address other than zero. "renounced": it returns the zero address.
  // "none": neither function answers. "unknown": they could not be asked (the RPC failed).
  state: "active" | "renounced" | "none" | "unknown";
  address: Address | null;
  via: "owner()" | "getOwner()" | null;
};

/** Where the token's logic lives: the token itself, or the implementation behind a proxy. */
export type CodeTarget = {
  address: Address;
  bytecode: Hex;
  /** The verified ABI when Sourcify (or Blockscout) has the source; null otherwise. */
  abi: AbiItem[] | null;
  abiSource: "Sourcify" | "Blockscout" | null;
  via: "token" | "eip1967" | "beacon" | "eip1167";
};

/** Everything the static checks need, resolved once so no check reads the chain again. */
export type CheckContext = {
  token: Address;
  owner: OwnerState;
  /** Null when the code to inspect could not be read (for a proxy: the implementation's code). */
  code: CodeTarget | null;
  /** Why `code` is null. */
  codeMissing?: string;
};
