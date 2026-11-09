/**
 * The map of launches by the asset they pair with: one system per pair asset, its core sized by how
 * many launches chose it, and each launch around it, closer the further its curve is towards
 * graduation (distance falls with the square root of that progress). The rules are fixed, so the
 * same launches always draw the same map, and nothing in it stands for a rating: size is a count,
 * distance is the curve's own progress.
 */
import type { Launch } from "./read";
import { progress } from "./facts";

export interface AtlasNode {
  launch: Launch;
  /** 0 to 1, or null when the curve's liquidity could not be read. */
  progress: number | null;
  /** Offset from the core's center, in cell units. */
  x: number;
  y: number;
}

export interface AtlasSystem {
  key: string;
  pair: Launch["pair"];
  launches: number;
  graduated: number;
  /** Sum of the pair asset the curves hold, in its smallest unit. */
  liquidity: bigint;
  /** Core radius, in cell units. */
  radius: number;
  /** The launches drawn, closest to graduation first; `hidden` more are not drawn. */
  nodes: AtlasNode[];
  hidden: number;
  /** The cell's top-left corner, in cell units. */
  x: number;
  y: number;
}

export interface AtlasLayout {
  systems: AtlasSystem[];
  /** Pair assets beyond `maxSystems`, folded into one count. */
  otherPairs: number;
  otherLaunches: number;
  width: number;
  height: number;
  cell: number;
}

export interface AtlasOptions {
  columns: number;
  maxSystems?: number;
  maxNodes?: number;
  /** Cell size in units; the drawing scales to its container. */
  cell?: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function layoutAtlas(launches: readonly Launch[], options: AtlasOptions): AtlasLayout {
  const cell = options.cell ?? 240;
  const maxSystems = options.maxSystems ?? 9;
  const maxNodes = options.maxNodes ?? 16;
  const columns = Math.max(1, Math.floor(options.columns));

  const groups = new Map<string, Launch[]>();
  for (const launch of launches) {
    const key = launch.pair.address.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(launch);
    else groups.set(key, [launch]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const kept = ordered.slice(0, maxSystems);
  const folded = ordered.slice(maxSystems);
  const most = kept[0]?.[1].length ?? 1;

  const coreMin = cell * 0.05;
  const coreMax = cell * 0.13;
  const orbitInner = cell * 0.06;
  const orbitOuter = cell * 0.36;

  const systems = kept.map(([key, list], index): AtlasSystem => {
    const radius = coreMin + (coreMax - coreMin) * Math.sqrt(list.length / most);
    const ranked = list
      .map((launch) => ({ launch, progress: progress(launch.liquidity, launch.graduationThreshold), graduated: launch.graduated === true }))
      .sort((a, b) => Number(b.graduated) - Number(a.graduated) || (b.progress ?? -1) - (a.progress ?? -1) || compareTokens(a.launch, b.launch));
    const drawn = ranked.slice(0, maxNodes);
    const nodes = drawn.map((item, i): AtlasNode => {
      // Graduated launches sit on the innermost ring; the rest move in as their curve fills. The
      // square root spreads out the first few percent, where most curves are.
      const reach = item.graduated ? 0 : 1 - Math.sqrt(item.progress ?? 0);
      const distance = radius + orbitInner + reach * (orbitOuter - radius - orbitInner);
      const angle = i * GOLDEN - Math.PI / 2;
      return { launch: item.launch, progress: item.progress, x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
    });
    return {
      key,
      pair: list[0]!.pair,
      launches: list.length,
      graduated: list.filter((launch) => launch.graduated === true).length,
      liquidity: list.reduce((sum, launch) => sum + (launch.liquidity ?? 0n), 0n),
      radius,
      nodes,
      hidden: list.length - drawn.length,
      x: (index % columns) * cell,
      y: Math.floor(index / columns) * cell,
    };
  });
  const rows = Math.max(1, Math.ceil(systems.length / columns));
  return {
    systems,
    otherPairs: folded.length,
    otherLaunches: folded.reduce((sum, [, list]) => sum + list.length, 0),
    width: Math.min(columns, Math.max(1, systems.length)) * cell,
    height: rows * cell,
    cell,
  };
}

function compareTokens(a: Launch, b: Launch): number {
  return a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1;
}
