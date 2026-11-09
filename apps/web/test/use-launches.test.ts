import { ChainReader, PONS_V2_FACTORY } from "@hyvo/launches";
import { DEMO_HEAD, DEMO_PACE, demoChain, type FakeChain } from "@hyvo/launches/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowState } from "../src/pages/launches/use-launches";

/*
 * useLaunchWindow without a DOM: React's hooks are swapped for ones that run the effect at once and
 * hand back its cleanup, and the page's reader reads the fictional Pons world of @hyvo/launches/testing.
 */
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  cleanups: [] as (() => void)[],
  reader: null as null | (() => unknown),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    hooks.state = initial;
    return [initial, (next: unknown) => (hooks.state = typeof next === "function" ? (next as (current: unknown) => unknown)(hooks.state) : next)];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));

vi.mock("../src/lib/launches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/launches")>()),
  launchesReader: () => hooks.reader!(),
}));

const { useLaunchWindow } = await import("../src/pages/launches/use-launches");

const RPC = "http://rpc.test";
let chain: FakeChain;

beforeEach(() => {
  chain = demoChain();
  hooks.state = undefined;
  hooks.cleanups = [];
  hooks.reader = () => new ChainReader({ callEndpoints: [RPC], logEndpoints: [RPC], fetch: chain.fetch });
});

/** Resolves once the chain has had no request for a few turns of the event loop: every read is done. */
async function settled() {
  let seen = -1;
  for (let calm = 0; calm < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    calm = chain.log.length === seen ? calm + 1 : 0;
    seen = chain.log.length;
  }
}

/** The factory's log queries for blocks before a 6-hour window: only Chain Pulse asks for those. */
function beforeTheWindow() {
  const windowFrom = DEMO_HEAD - BigInt(Math.round(6 * 3600 * DEMO_PACE)) + 1n;
  return chain.log.filter((entry) => {
    if (entry.method !== "eth_getLogs") return false;
    const filter = entry.params[0] as { address?: string; toBlock: string };
    return typeof filter.address === "string" && filter.address.toLowerCase() === PONS_V2_FACTORY.toLowerCase() && BigInt(filter.toBlock) < windowFrom;
  });
}

describe("useLaunchWindow", () => {
  it("reads the hours before the window for Chain Pulse while the page shows it", async () => {
    useLaunchWindow(6, 0);
    await settled();
    expect((hooks.state as WindowState).pulse.status).toBe("ready");
    expect(beforeTheWindow().length).toBeGreaterThan(0);
  });

  it("starts no Chain Pulse read once its effect is cleaned up", async () => {
    useLaunchWindow(6, 0);
    // Left before the first answer: another page, another window, or React's development double run.
    hooks.cleanups.pop()!();
    await settled();
    expect(beforeTheWindow()).toEqual([]);
  });
});
