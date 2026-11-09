/**
 * Hyvo Launches payloads (docs/API.md, "Hyvo Launches"). `GET /v1/launches/creator/:address`: every Pons V2
 * launch by one wallet, from the factory's TokenLaunched logs in Blockscout's index. The web app reads each
 * curve's state now from the chain itself; this answer carries only what the logs say.
 */
import { z } from "zod";
import { Address, Hash32, Timestamp } from "./run";

/** A whole number as decimal digits (wei and other smallest units). */
const Digits = z.string().regex(/^\d{1,78}$/);

export const CreatorLaunchView = z.strictObject({
  token: Address,
  curve: Address,
  /** The zero address for ETH. */
  pairToken: Address,
  launchConfigId: Digits,
  /** In the pair asset's smallest unit. */
  graduationThreshold: Digits,
  /** The launch's block on Robinhood Chain. */
  block: z.int().nonnegative(),
  /** The launch block's time in seconds, when the index gave it. */
  timestamp: z.int().nonnegative().nullable(),
  txHash: Hash32,
  logIndex: z.int().nonnegative(),
});

export const CreatorLaunchesResponse = z.strictObject({
  creator: Address,
  /** The Pons V2 launch factory whose logs were read. */
  factory: Address,
  /** Newest first; null when Blockscout's index could not be read (`missing` says why). */
  launches: z.array(CreatorLaunchView).nullable(),
  /** False when the list stopped at the page limit, so older or newer launches may be missing. */
  complete: z.boolean(),
  missing: z.string().nullable(),
  /** Where the logs came from and when. */
  source: z.string(),
  readAt: Timestamp,
  disclaimer: z.string(),
});

export type CreatorLaunchView = z.infer<typeof CreatorLaunchView>;
export type CreatorLaunchesResponse = z.infer<typeof CreatorLaunchesResponse>;
