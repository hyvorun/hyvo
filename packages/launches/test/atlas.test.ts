import { describe, expect, it } from "vitest";
import { layoutAtlas } from "../src/atlas";
import { ETH, type Asset, type Launch } from "../src/read";

const NVDA: Asset = { address: "0x00000000000000000000000000000000000000aa", symbol: "NVDA", name: "NVIDIA", decimals: 18 };
const USDG: Asset = { address: "0x00000000000000000000000000000000000000bb", symbol: "USDG", name: "Global Dollar", decimals: 6 };

function launch(i: number, pair: Asset, liquidity: bigint, graduated = false): Launch {
  const hex = i.toString(16).padStart(40, "0");
  return {
    token: `0x${hex}`,
    curve: `0x${hex}`,
    creator: `0x${hex}`,
    pair,
    symbol: `T${i}`,
    name: null,
    launchedAt: 1_000 + i,
    block: BigInt(i),
    txHash: null,
    creatorTaxBps: 0,
    graduated,
    liquidity,
    graduationThreshold: 100n,
  };
}

describe("the atlas", () => {
  const launches = [
    ...Array.from({ length: 30 }, (_, i) => launch(i, ETH, BigInt(i * 3))),
    launch(100, NVDA, 90n),
    launch(101, NVDA, 10n),
    launch(102, USDG, 0n, true),
  ];

  it("draws one system per pair asset, the most chosen first", () => {
    const layout = layoutAtlas(launches, { columns: 3 });
    expect(layout.systems.map((system) => system.pair.symbol)).toEqual(["ETH", "NVDA", "USDG"]);
    expect(layout.systems[0]!.launches).toBe(30);
    expect(layout.systems[0]!.radius).toBeGreaterThan(layout.systems[1]!.radius);
    expect(layout.systems[2]!.graduated).toBe(1);
    expect(layout.width).toBe(3 * layout.cell);
  });

  it("puts a curve closer to its core the further it is towards graduation", () => {
    const layout = layoutAtlas(launches, { columns: 3 });
    const nvda = layout.systems[1]!;
    const distance = (node: (typeof nvda.nodes)[number]) => Math.hypot(node.x, node.y);
    const near = nvda.nodes.find((node) => node.launch.symbol === "T100")!;
    const far = nvda.nodes.find((node) => node.launch.symbol === "T101")!;
    expect(distance(near)).toBeLessThan(distance(far));
    // Every node stays inside its cell.
    for (const system of layout.systems) for (const node of system.nodes) expect(distance(node)).toBeLessThan(layout.cell / 2);
  });

  it("caps the nodes and the systems, and folds the rest into counts", () => {
    const layout = layoutAtlas(launches, { columns: 2, maxNodes: 10, maxSystems: 2 });
    expect(layout.systems[0]!.nodes).toHaveLength(10);
    expect(layout.systems[0]!.hidden).toBe(20);
    expect(layout.otherPairs).toBe(1);
    expect(layout.otherLaunches).toBe(1);
    expect(layout.height).toBe(layout.cell);
  });

  it("draws the same map for the same launches", () => {
    expect(layoutAtlas([...launches].reverse(), { columns: 3 })).toEqual(layoutAtlas(launches, { columns: 3 }));
  });
});
