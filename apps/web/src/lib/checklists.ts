/**
 * Two checklists: one for people launching a token, one for people looking at a new token. They
 * ask questions; they never give a verdict on a token, and ticking every box does not make a token
 * safe. Ids are stable, because progress is saved under them in the browser.
 */

export interface CheckItem {
  id: string;
  text: string;
  detail: string;
  /** A tool or page that helps answer it. */
  link?: { to: string; label: string };
}

export interface CheckGroup {
  title: string;
  items: CheckItem[];
}

export interface Checklist {
  id: "launch" | "trade";
  title: string;
  lede: string;
  groups: CheckGroup[];
}

export const CHECKLISTS: Checklist[] = [
  {
    id: "launch",
    title: "Before you launch a token",
    lede: "What people will ask in the first hour, answered before they ask it.",
    groups: [
      {
        title: "The token",
        items: [
          {
            id: "launch-purpose",
            text: "Say what the token is for in one sentence",
            detail: "If you cannot, the crowd will write that sentence for you, and you will not like it.",
          },
          {
            id: "launch-supply",
            text: "Publish the supply and who holds what",
            detail: "Team, liquidity, anything held back. Concentrated holdings are the first thing skeptics look for.",
            link: { to: "/tools/market-cap", label: "Market cap calculator" },
          },
          {
            id: "launch-tax",
            text: "Decide the trading tax, who receives it, and whether it can change",
            detail: "A tax nobody explained reads as a trap. One that can change later reads as a bigger one.",
            link: { to: "/tools/swap", label: "Swap calculator" },
          },
          {
            id: "launch-liquidity",
            text: "Decide how much liquidity goes in, and whether it is locked",
            detail: "Thin liquidity means every trade moves the price a lot. Check what a typical first trade does.",
            link: { to: "/tools/swap", label: "Swap calculator" },
          },
          {
            id: "launch-powers",
            text: "List what the owner of the contract can still do",
            detail: "Mint, pause, blacklist, change fees. Say it plainly, or give the powers up and say that.",
          },
        ],
      },
      {
        title: "The launch",
        items: [
          {
            id: "launch-address",
            text: "Post the contract address in one pinned, official place",
            detail: "Copies with the same name appear within minutes. Tell people where the real address lives.",
          },
          {
            id: "launch-post",
            text: "Put the launch post in front of a crowd first",
            detail: "See which line gets quoted back at you, and which objection comes up first.",
            link: { to: "/new", label: "Run a simulation" },
          },
          {
            id: "launch-answers",
            text: "Prepare answers to the obvious questions",
            detail: "Who is behind it, where the fees go, what happens next week. With numbers where you have them.",
          },
          {
            id: "launch-promises",
            text: "Promise no price and no return",
            detail: "It is the line that ages worst, and in many places it is also a legal problem.",
          },
        ],
      },
      {
        title: "After",
        items: [
          {
            id: "launch-follow",
            text: "Do what you said you would, in public",
            detail: "If you said the team wallet stays put, people will watch it. Explain any move before it happens.",
          },
          {
            id: "launch-log",
            text: "Keep a changelog",
            detail: "Dated, short entries. It answers half the questions in the chat by itself.",
          },
        ],
      },
    ],
  },
  {
    id: "trade",
    title: "Before you trade a new token",
    lede: "Questions worth answering for yourself. They do not tell you what to do, and no list makes a token safe.",
    groups: [
      {
        title: "The contract",
        items: [
          {
            id: "trade-address",
            text: "Did the address come from the project's own pinned post?",
            detail: "Not from a reply, a direct message or a search result. Copies with the same name are common.",
          },
          {
            id: "trade-powers",
            text: "Can the owner mint more, pause trading or change the tax?",
            detail: "A verified contract on a block explorer lets you read its functions. Unverified code is a question in itself.",
            link: { to: "/tools/glossary#verified-contract", label: "What “verified” means" },
          },
          {
            id: "trade-tax",
            text: "Is there a tax on trades, and who receives it?",
            detail: "A 5% tax each way costs about 10% on a quick round trip, before any price move.",
            link: { to: "/tools/swap", label: "Swap calculator" },
          },
        ],
      },
      {
        title: "The market",
        items: [
          {
            id: "trade-liquidity",
            text: "How much liquidity is in the pool, and is it locked?",
            detail: "Liquidity that can be pulled out can disappear in one transaction.",
            link: { to: "/tools/glossary#rug-pull", label: "Rug pull" },
          },
          {
            id: "trade-impact",
            text: "How much would your own trade move the price?",
            detail: "In a thin pool, your trade can be the move. Work it out before you sign.",
            link: { to: "/tools/swap", label: "Swap calculator" },
          },
          {
            id: "trade-holders",
            text: "How concentrated are the holders?",
            detail: "If a few wallets hold most of the supply, their next move matters more than anything posted.",
          },
          {
            id: "trade-exit",
            text: "Has anyone been able to get out again?",
            detail: "A token that can be entered but not left is called a honeypot.",
            link: { to: "/tools/glossary#honeypot", label: "Honeypot" },
          },
        ],
      },
      {
        title: "You",
        items: [
          {
            id: "trade-why",
            text: "Can you say why, without quoting someone else's post?",
            detail: "If the reason is that the feed is excited, that is the reason the KOL follower has too.",
            link: { to: "/tools/quiz", label: "Which trader are you?" },
          },
          {
            id: "trade-size",
            text: "Is the amount one you can afford to lose entirely?",
            detail: "Many new tokens end up worth nothing, including ones that looked busy on their first day.",
          },
          {
            id: "trade-approval",
            text: "Are you approving only what this trade needs?",
            detail: "An unlimited approval lets a contract move that token from your wallet later. Revoke what you no longer use.",
            link: { to: "/tools/glossary#approval", label: "Approval" },
          },
        ],
      },
    ],
  },
];
