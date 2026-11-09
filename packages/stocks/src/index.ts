/**
 * @hyvo/stocks: read-only facts about Robinhood stock tokens on Robinhood Chain, for the web app,
 * a CLI command or the Worker. Facts come from the chain (the StockFactory, each token and
 * Chainlink's feeds, read at one block) and from Chainlink's feed directory for the feeds'
 * addresses. Nothing here signs or sends a transaction, and nothing here is a trading signal.
 */
export * from "./contracts";
export * from "./decimal";
export * from "./facts";
export * from "./feeds";
export * from "./query";
export * from "./read";
export * from "./report";
export * from "./session";
export * from "./snapshot";

/** The line every page of facts ends with. */
export function measuredLine(block: bigint | number): string {
  return `Measured on-chain at block ${Number(block).toLocaleString("en-US")}. Not a trading signal.`;
}
