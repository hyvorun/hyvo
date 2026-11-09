// DATA, not logic: launchpads on Robinhood Chain that keep an on-chain record of every token they launch, so a
// token's origin is read from the launchpad itself rather than guessed from its deployer. Addresses and sources
// in addresses.ts and docs/OPEN_ITEMS.md item 5.

import type { Address } from "../types.js";
import { ADDRESSES } from "./addresses.js";

export type Launchpad = {
  name: string;
  /** The factory whose getLaunchedToken(token) says whether it launched a token, and who launched it. */
  factory: Address;
};

export const PONS_V2: Launchpad = { name: "Pons v2", factory: ADDRESSES.ponsV2Factory.address };
export const PONS_V1: Launchpad = { name: "Pons v1", factory: ADDRESSES.ponsV1Factory.address };

export const LAUNCHPADS: Launchpad[] = [PONS_V2, PONS_V1];
