import { ADDRESSES } from "./addresses";
import { EXPLORER_URL, addressUrl } from "./explorer";

/**
 * Hyvo's official addresses. Anything else that claims to be Hyvo is not: the header, the footer and
 * /trust show these so a copy of the site or a lookalike account is easy to tell apart.
 */
export const OFFICIAL = {
  site: { label: "hyvo.run", url: "https://hyvo.run" },
  x: { handle: "@Hyvorun", url: "https://x.com/Hyvorun" },
} as const;

/** The HYVO token once it has launched: its one address, and where to read about it. */
export interface OfficialToken {
  address: string;
  /** The address on the block explorer, and the explorer's name for a link to it. */
  explorerUrl: string;
  explorerName: string;
  /** Hyvo Check's page for the token. */
  checkPath: string;
  /** Hyvo Launches' page for its launch. */
  launchPath: string;
}

/** The facts the site shows for the token at `address`; null for no address (before the launch). */
export function officialToken(address: string): OfficialToken | null {
  if (!address) return null;
  return {
    address,
    explorerUrl: addressUrl(address),
    explorerName: /blockscout/i.test(EXPLORER_URL) ? "Blockscout" : "the block explorer",
    checkPath: `/check/${address}`,
    launchPath: `/launches/${address}`,
  };
}

/**
 * HYVO as this build knows it. The deploy passes its address from chain/deployments/4663.json, where
 * the zero address stands for "not launched", which gives null here. Every page that speaks of the
 * token switches between "coming" and "live" on this alone.
 */
export const HYVO_TOKEN = officialToken(ADDRESSES.hyvoToken);

/** The line that goes with the address wherever the site shows it. */
export const ONLY_TOKEN = "This is Hyvo's only token. A token at any other address is not Hyvo's, whatever its name.";
