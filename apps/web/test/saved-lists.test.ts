import { describe, expect, it } from "vitest";
import {
  addTo,
  cleanList,
  LIST_KEYS,
  LIST_MAX,
  loadList,
  mergeLists,
  parseAddress,
  removeFrom,
  sameList,
  saveList,
  trackLimit,
  type StorageLike,
} from "../src/lib/saved-lists";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

const blocked: StorageLike = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("addresses typed by a person", () => {
  it("accepts 0x and 40 hex characters, trimmed, in lowercase", () => {
    expect(parseAddress(`  0x${"AB".repeat(20)}  `)).toBe(`0x${"ab".repeat(20)}`);
    expect(parseAddress("0x123")).toBeNull();
    expect(parseAddress(`${"ab".repeat(20)}`)).toBeNull();
    expect(parseAddress(`0x${"zz".repeat(20)}`)).toBeNull();
    expect(parseAddress("<img src=x>")).toBeNull();
  });
});

describe("lists in the browser", () => {
  it("keep each address once, in order, at most the limit, and drop anything else", () => {
    expect(cleanList([a(2), a(1), a(2).toUpperCase().replace("0X", "0x"), 7, null, "nope", a(3)], 10)).toEqual([a(2), a(1), a(3)]);
    expect(cleanList([a(1), a(2), a(3)], 2)).toEqual([a(1), a(2)]);
  });

  it("are saved and read back under their own keys", () => {
    const storage = memory();
    expect(saveList(storage, "watchlist", [a(1), a(2)])).toBe(true);
    expect(saveList(storage, "tracked", [a(9)])).toBe(true);
    expect(loadList(storage, "watchlist")).toEqual([a(1), a(2)]);
    expect(loadList(storage, "tracked")).toEqual([a(9)]);
    expect(JSON.parse(storage.data.get(LIST_KEYS.watchlist)!)).toEqual([a(1), a(2)]);
  });

  it("read as empty when nothing, something unreadable, or something else is stored", () => {
    const storage = memory();
    expect(loadList(storage, "watchlist")).toEqual([]);
    storage.data.set(LIST_KEYS.watchlist, "{oops");
    expect(loadList(storage, "watchlist")).toEqual([]);
    storage.data.set(LIST_KEYS.watchlist, JSON.stringify({ tokens: [a(1)] }));
    expect(loadList(storage, "watchlist")).toEqual([]);
    storage.data.set(LIST_KEYS.tracked, JSON.stringify(Array.from({ length: 40 }, (_, i) => a(i + 1))));
    expect(loadList(storage, "tracked")).toHaveLength(LIST_MAX.tracked);
  });

  it("work without storage: nothing is read, and a save says it was not kept", () => {
    expect(loadList(blocked, "watchlist")).toEqual([]);
    expect(saveList(blocked, "watchlist", [a(1)])).toBe(false);
    expect(loadList(null, "tracked")).toEqual([]);
    expect(saveList(null, "tracked", [a(1)])).toBe(false);
  });
});

describe("changing a list", () => {
  it("adds an address once, up to the limit", () => {
    expect(addTo([], a(1), 1)).toEqual({ list: [a(1)], result: "added" });
    expect(addTo([a(1)], a(1).toUpperCase().replace("0X", "0x"), 5)).toEqual({ list: [a(1)], result: "already" });
    expect(addTo([a(1)], a(2), 1)).toEqual({ list: [a(1)], result: "full" });
    expect(addTo([a(1)], "0xnope", 5)).toEqual({ list: [a(1)], result: "invalid" });
  });

  it("removes an address whatever its case", () => {
    expect(removeFrom([a(1), a(2)], a(2).toUpperCase().replace("0X", "0x"))).toEqual([a(1)]);
  });

  it("joins the account's list and this browser's, the account's first", () => {
    expect(mergeLists([a(3), a(1)], [a(1), a(2)], 10)).toEqual([a(3), a(1), a(2)]);
    expect(mergeLists([a(3), a(1)], [a(2)], 2)).toEqual([a(3), a(1)]);
    expect(sameList([a(1)], [a(1).toUpperCase().replace("0X", "0x")])).toBe(true);
    expect(sameList([a(1)], [a(1), a(2)])).toBe(false);
  });
});

describe("how many wallets one can follow", () => {
  it("is 25 for holders and 1 for everyone else", () => {
    expect(trackLimit("holder")).toBe(25);
    expect(trackLimit("not-holder")).toBe(1);
    expect(trackLimit("signed-out")).toBe(1);
    expect(trackLimit("unknown")).toBe(1);
  });
});
