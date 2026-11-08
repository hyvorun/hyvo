/** The free tools, as data: the hub lists them, each tool page links the others, the home page shows a few. */

export interface ToolInfo {
  to: string;
  name: string;
  line: string;
  group: "Calculators" | "Guides" | "Just for fun";
}

export const TOOLS: ToolInfo[] = [
  { to: "/tools/swap", name: "Swap and price impact", line: "What a trade gets, and how far it moves a pool's price.", group: "Calculators" },
  { to: "/tools/impermanent-loss", name: "Impermanent loss", line: "What providing liquidity costs when prices move apart.", group: "Calculators" },
  { to: "/tools/market-cap", name: "Market cap and supply", line: "Market cap, fully diluted value and a holding's share.", group: "Calculators" },
  { to: "/tools/units", name: "Units", line: "Wei, gwei and ETH, token decimals, basis points.", group: "Calculators" },
  { to: "/tools/checklist", name: "Checklists", line: "Questions to answer before a launch, or before a trade.", group: "Guides" },
  { to: "/tools/glossary", name: "Glossary", line: "The words around token launches, in plain language.", group: "Guides" },
  { to: "/tools/quiz", name: "Which trader are you?", line: "Ten questions, one of ten archetypes.", group: "Just for fun" },
];

/** The ones the home page shows. */
export const HOME_TOOLS = ["/tools/swap", "/tools/quiz", "/tools/checklist", "/tools/glossary"].map((to) => TOOLS.find((tool) => tool.to === to)!);
