/**
 * Keyless public endpoints of Robinhood Chain that answered a browser on 2026-11-09, with what each
 * was measured to serve (docs/OPEN_ITEMS.md item 28). All of them reply with CORS headers. The
 * reader only reads: no endpoint here is ever sent a transaction.
 *
 * - dRPC: eth_call and headers; log queries over about 100 blocks only, so not used for logs.
 * - Pocket: often refuses a log query without an address ("request is too complex/large"), so such a
 *   query asks it last; takes ten addresses at most, and spans 10,001 blocks on most of its nodes and
 *   50,000 on some.
 * - Robinhood's own endpoint: log queries over 250,000 blocks with an address and 30,000 without
 *   one. Its terms say it is rate limited and not for production, and some ISPs block its domain
 *   (docs/OPEN_ITEMS.md items 3 and 14), so it comes after Pocket, and is the one that answers a
 *   query across every curve at once.
 * - degenprotocol: a proxy listed on chainlist as not tracking, whose answers vary by node; last.
 */
import { ChainReader, type FetchLike, type LogEndpointOption } from "./rpc";

const ROBINHOOD = "https://rpc.mainnet.chain.robinhood.com";

export const CALL_ENDPOINTS: readonly string[] = ["https://robinhood.drpc.org", "https://robinhood.api.pocket.network", ROBINHOOD];

export const LOG_ENDPOINTS: readonly LogEndpointOption[] = [
  { url: "https://robinhood.api.pocket.network", maxSpan: 10_000, addresslessLast: true },
  { url: ROBINHOOD, maxSpan: 50_000 },
  { url: "https://rpc.degenprotocol.io/robinhood", maxSpan: 10_000 },
];

/**
 * Robinhood's endpoint answers a body sent as plain text with "invalid content type, only
 * application/json is supported"; the others accept it, which spares a browser the CORS preflight.
 */
export const JSON_ONLY: readonly string[] = [ROBINHOOD];

/** A reader over the public endpoints, or over `urls` (tests point it at a stub). */
export function publicReader(options: { urls?: readonly string[]; fetch?: FetchLike } = {}): ChainReader {
  const urls = options.urls?.filter(Boolean) ?? [];
  return new ChainReader({
    callEndpoints: urls.length > 0 ? urls : CALL_ENDPOINTS,
    logEndpoints: urls.length > 0 ? urls : LOG_ENDPOINTS,
    jsonOnly: JSON_ONLY,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
