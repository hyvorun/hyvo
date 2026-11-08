/**
 * Wallet Clone (SPEC 11.3): the statistics of a wallet that proved itself with a signature. Numbers only: no address, no token, no date, and nothing
 * guessed about the person. The engine computes them (engine/hyvo/clone/profile.py).
 */
import { z } from "zod";
import { Timestamp } from "./run";

const Count = z.int().nonnegative();
const Pct = z.int().min(0).max(100).nullable();
const Measure = z.number().nonnegative().nullable();

export const CloneProfile = z.strictObject({
  version: z.literal(1),
  trades: Count,
  buys: Count,
  sells: Count,
  tokens: Count,
  typicalBuyEth: Measure,
  smallBuyEth: Measure,
  largeBuyEth: Measure,
  medianHoldHours: Measure,
  soldWithinHourPct: Pct,
  stillHeldPct: Pct,
  medianSellPct: Pct,
  medianEntryMinutes: Measure,
  earlyEntryPct: Pct,
});

export const CloneView = z.strictObject({
  status: z.enum(["building", "ready", "failed"]),
  profile: CloneProfile.nullable(),
  failReason: z.string().nullable(),
  updatedAt: Timestamp,
});

export const CloneResponse = z.strictObject({ clone: CloneView.nullable(), open: z.boolean(), disclaimer: z.string() });

export type CloneProfile = z.infer<typeof CloneProfile>;
export type CloneView = z.infer<typeof CloneView>;
export type CloneResponse = z.infer<typeof CloneResponse>;
