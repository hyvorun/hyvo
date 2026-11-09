/**
 * Keyless public endpoints of Robinhood Chain that answered a browser on 2026-11-09, with what each
 * was measured to serve (docs/OPEN_ITEMS.md item 28). All of them reply with CORS headers.
 *
 * - dRPC: eth_call and headers; log queries over about 100 blocks only, so not used for logs.
 * - Pocket: log queries need an address (ten at most) and span 10,001 blocks on most of its nodes
 *   and 50,000 on some.
 * - Robinhood's own endpoint: log queries over 250,000 blocks with an address and 30,000 without
 *   one. Its terms say it is rate limited and not for production, and some ISPs block its domain
 *   (docs/OPEN_ITEMS.md items 3 and 14), so it comes after Pocket, and is the one that answers a
 *   query across every curve at once.
 * - degenprotocol: a proxy listed on chainlist as not tracking, whose answers vary by node; last.
 */
import { ChainReader, type FetchLike, type LogEndpointOption } from "./rpc";

export const CALL_ENDPOINTS: readonly string[] = ["https://robinhood.drpc.org", "https://robinhood.api.pocket.network", "https://rpc.mainnet.chain.robinhood.com"];

export const LOG_ENDPOINTS: readonly LogEndpointOption[] = [
  { url: "https://robinhood.api.pocket.network", maxSpan: 10_000 },
  { url: "https://rpc.mainnet.chain.robinhood.com", maxSpan: 50_000 },
  { url: "https://rpc.degenprotocol.io/robinhood", maxSpan: 10_000 },
];

/** A reader over the public endpoints, or over `urls` (tests point it at a stub). */
export function publicReader(options: { urls?: readonly string[]; fetch?: FetchLike } = {}): ChainReader {
  const urls = options.urls?.filter(Boolean) ?? [];
  return new ChainReader({
    callEndpoints: urls.length > 0 ? urls : CALL_ENDPOINTS,
    logEndpoints: urls.length > 0 ? urls : LOG_ENDPOINTS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
