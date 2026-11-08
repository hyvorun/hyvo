/**
 * Plain-language definitions of the words people meet around token launches, and of Hyvo's own
 * words. General definitions only: nothing here describes a particular token, launchpad or
 * exchange. The id is the anchor (/tools/glossary#price-impact).
 */

export interface Term {
  id: string;
  term: string;
  definition: string;
  /** Hyvo's own word rather than a general one. */
  hyvo?: boolean;
  link?: { to: string; label: string };
}

export const TERMS: Term[] = [
  {
    id: "amm",
    term: "AMM (automated market maker)",
    definition: "A contract that trades from a pool of two tokens by a fixed formula instead of matching buyers with sellers. The price follows from what is in the pool.",
  },
  {
    id: "approval",
    term: "Approval",
    definition:
      "Permission you give a contract to move a set amount of one of your tokens. An unlimited approval stays in force until you revoke it, so approve only what a transaction needs.",
  },
  {
    id: "archetype",
    term: "Archetype",
    hyvo: true,
    definition: "A kind of trader that Hyvo's agents play: a sniper, a holder, a skeptic and seven more. Archetypes describe behavior. They are never real people.",
    link: { to: "/tools/quiz", label: "Which one are you?" },
  },
  {
    id: "basis-point",
    term: "Basis point",
    definition: "One hundredth of a percent. 100 basis points are 1%, so a fee of 30 basis points is 0.3%.",
    link: { to: "/tools/units", label: "Unit converter" },
  },
  {
    id: "block",
    term: "Block",
    definition: "A batch of transactions the chain adds at once. Blocks are numbered, so a block number marks a moment in the chain's history.",
  },
  {
    id: "block-explorer",
    term: "Block explorer",
    definition: "A website that shows what is on a chain: transactions, blocks, addresses, and the code of contracts whose source was published.",
  },
  {
    id: "bonding-curve",
    term: "Bonding curve",
    definition:
      "A formula that sets a token's price from how many tokens have been issued so far. Some launchpads sell a new token along a curve before it moves to a regular pool.",
  },
  {
    id: "calibration",
    term: "Calibration",
    hyvo: true,
    definition: "Hyvo's public record of how the crowds' answers to yes or no questions turned out, misses included.",
    link: { to: "/calibration", label: "Calibration" },
  },
  {
    id: "circulating-supply",
    term: "Circulating supply",
    definition: "The tokens that can actually trade now, as opposed to the total supply, which also counts tokens that are locked or not yet issued.",
  },
  {
    id: "constant-product",
    term: "Constant product (x × y = k)",
    definition:
      "The rule of the simplest AMM pools: the two reserves multiplied together stay the same through a trade, before fees. Taking out more of one token costs more and more of the other.",
    link: { to: "/tools/swap", label: "Swap calculator" },
  },
  {
    id: "dry-run",
    term: "Dry Run",
    hyvo: true,
    definition: "Hyvo letting a crowd of synthetic users try a contract on a private copy of the chain before mainnet, to see what breaks. It is not an audit.",
    link: { to: "/dryrun", label: "Dry Run" },
  },
  {
    id: "exit-liquidity",
    term: "Exit liquidity",
    definition: "The people whose late entry lets earlier holders leave at a good price. Nobody wants to be it.",
  },
  {
    id: "fdv",
    term: "FDV (fully diluted value)",
    definition: "The price of one token times the total supply, including tokens that are not circulating yet. It can be far above the market cap.",
    link: { to: "/tools/market-cap", label: "Market cap calculator" },
  },
  {
    id: "fork",
    term: "Fork",
    definition:
      "A private copy of a chain taken at one block. Transactions on a fork stay on the fork: they cost nothing real and never reach the public chain. Hyvo's crowds trade on forks.",
  },
  {
    id: "gas",
    term: "Gas",
    definition: "The fee for the work a transaction asks of the chain, paid in the chain's own currency to the network, not to the app you use.",
  },
  {
    id: "gwei",
    term: "Gwei",
    definition: "One billionth of an ETH. Gas prices are usually quoted in gwei.",
    link: { to: "/tools/units", label: "Unit converter" },
  },
  {
    id: "hash",
    term: "Hash",
    definition:
      "A short fingerprint of a file. Change one character and the hash changes completely, so a published hash proves that a file is the same one later. Hyvo hashes every run with keccak-256.",
  },
  {
    id: "honeypot",
    term: "Honeypot",
    definition: "A token that can be entered but not left: the contract blocks or heavily taxes getting out, usually without saying so.",
  },
  {
    id: "impermanent-loss",
    term: "Impermanent loss",
    definition:
      "What a liquidity provider gives up, against simply holding both tokens, when their prices move apart. It grows with the size of the move, and fees can offset it.",
    link: { to: "/tools/impermanent-loss", label: "Impermanent loss calculator" },
  },
  {
    id: "kol",
    term: "KOL",
    definition: "Key opinion leader: an account with a large following whose posts move attention, and sometimes prices.",
  },
  {
    id: "liquidity",
    term: "Liquidity",
    definition: "How much can be traded without moving the price much. In a pool, it is the size of the reserves.",
  },
  {
    id: "liquidity-lock",
    term: "Liquidity lock",
    definition: "Liquidity placed in a contract that cannot release it before a date, or ever. It removes one way to pull the pool, not every risk.",
  },
  {
    id: "liquidity-pool",
    term: "Liquidity pool",
    definition: "Two tokens held together in an AMM contract so that anyone can trade one for the other. Whoever adds the tokens is a liquidity provider.",
  },
  {
    id: "market-cap",
    term: "Market cap",
    definition: "The price of one token times the circulating supply. It is arithmetic on the last price, not money anyone could take out.",
    link: { to: "/tools/market-cap", label: "Market cap calculator" },
  },
  {
    id: "multisig",
    term: "Multisig",
    definition: "A wallet that needs several keys to agree before it can act, so no single person can move what it holds.",
  },
  {
    id: "non-custodial",
    term: "Non-custodial",
    definition: "A service that never holds your money or your keys. You sign every transaction yourself.",
  },
  {
    id: "oracle",
    term: "Oracle",
    hyvo: true,
    definition:
      "In general, a contract that brings outside facts on-chain. Hyvo's oracle, HyvoOracle, records the hash of every published run on Robinhood Chain, where nobody can change it afterwards.",
    link: { to: "/oracle", label: "The oracle" },
  },
  {
    id: "price-impact",
    term: "Price impact",
    definition: "How far your own trade moves the pool's price. The larger the trade next to the pool, the larger the impact.",
    link: { to: "/tools/swap", label: "Swap calculator" },
  },
  {
    id: "reserves",
    term: "Reserves",
    definition: "The amounts of each token in a pool. Their ratio is the pool's price.",
  },
  {
    id: "rewind",
    term: "Rewind",
    hyvo: true,
    definition: "Hyvo playing a past moment of a real pool again with one thing changed, and setting the result next to what really happened.",
    link: { to: "/rewind", label: "Rewind" },
  },
  {
    id: "round",
    term: "Round",
    hyvo: true,
    definition: "One step of a Hyvo run. In each round every agent reads the feed and the market, then posts, trades or waits.",
  },
  {
    id: "rug-pull",
    term: "Rug pull",
    definition: "When the people behind a token take the pool's liquidity or dump their holdings at once, leaving everyone else with tokens that cannot be sold for much.",
  },
  {
    id: "seed-phrase",
    term: "Seed phrase",
    definition: "The words that restore a wallet. Whoever has them has the wallet. No real service ever asks for them.",
  },
  {
    id: "siwe",
    term: "Sign-In with Ethereum",
    definition: "Signing in by signing a message with your wallet. A signature is not a transaction: it moves nothing and costs no gas. Hyvo signs you in this way.",
  },
  {
    id: "slippage",
    term: "Slippage",
    definition:
      "The gap between the price you expected and the price you got, from your own price impact and from others trading first. Slippage tolerance is the most you accept before the trade fails instead.",
    link: { to: "/tools/swap", label: "Swap calculator" },
  },
  {
    id: "sniper",
    term: "Sniper",
    definition: "A trader, often a bot, who gets into new pools in their first moments and leaves on the first run-up.",
  },
  {
    id: "synthetic-crowd",
    term: "Synthetic crowd",
    hyvo: true,
    definition:
      "Hyvo's AI agents, each playing an archetype, reacting to a scenario together: posting, replying and trading. What they do is a synthetic crowd reaction, not a forecast and not a trading signal.",
    link: { to: "/runs", label: "Published runs" },
  },
  {
    id: "trading-tax",
    term: "Trading tax",
    definition: "A share of every trade that a token's contract or its pool sends somewhere, often to the creator. It is on top of the pool's own fee, if any.",
    link: { to: "/tools/swap", label: "Swap calculator" },
  },
  {
    id: "verified-contract",
    term: "Verified contract",
    definition:
      "A contract whose source code was published and checked to compile to exactly the code on-chain, so anyone can read what it does. Verified does not mean safe.",
  },
  {
    id: "wallet-clone",
    term: "Wallet Clone",
    hyvo: true,
    definition: "An agent that trades by the statistics of one wallet's real history, so its owner can watch a copy of their habits in a run.",
    link: { to: "/clone", label: "Wallet Clone" },
  },
  {
    id: "wei",
    term: "Wei",
    definition: "The smallest unit of ETH. One ETH is 1,000,000,000,000,000,000 wei (10¹⁸).",
    link: { to: "/tools/units", label: "Unit converter" },
  },
  {
    id: "whale",
    term: "Whale",
    definition: "A wallet large enough that its trades move the market, and that others watch for that reason.",
  },
];
