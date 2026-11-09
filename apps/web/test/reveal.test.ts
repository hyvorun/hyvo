import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * useInView without a DOM: React's hooks are swapped for ones that run the effect at once, the ref
 * holds a stand-in element, and the IntersectionObserver hands its callback to the test.
 */
const hooks = vi.hoisted(() => ({ seen: false, element: null as unknown }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: () => ({ current: hooks.element }),
  useState: (initial: boolean) => [initial, (next: boolean) => (hooks.seen = next)],
  useEffect: (effect: () => void) => {
    effect();
  },
}));

const { useInView } = await import("../src/components/Reveal");

class FakeObserver {
  static last: FakeObserver | null = null;
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.last = this;
  }
  observe() {}
  disconnect() {}
}

/** An entry for a 400px block on an 800px screen, `ratio` of it in view. */
function entry(ratio: number): IntersectionObserverEntry {
  return {
    isIntersecting: ratio > 0,
    intersectionRatio: ratio,
    intersectionRect: { height: 400 * ratio },
    rootBounds: { height: 800 },
  } as unknown as IntersectionObserverEntry;
}

function deliver(entries: IntersectionObserverEntry[]) {
  FakeObserver.last!.callback(entries, FakeObserver.last as unknown as IntersectionObserver);
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  hooks.seen = false;
  hooks.element = { addEventListener() {}, removeEventListener() {} };
});

describe("useInView", () => {
  it("shows a block once enough of it is in view", () => {
    useInView();
    deliver([entry(0.05)]);
    expect(hooks.seen).toBe(false);
    deliver([entry(0.5)]);
    expect(hooks.seen).toBe(true);
  });

  // A callback that runs late brings every entry queued for the block since the last one, oldest first.
  it("goes by the newest entry when one callback brings several", () => {
    useInView();
    deliver([entry(0), entry(0.5)]);
    expect(hooks.seen).toBe(true);
  });
});
