import { keccak256 as viemKeccak, toHex as viemToHex } from "viem";
import { describe, expect, it } from "vitest";
import { SELECTORS, funcSelector } from "../src/chain/abi";
import { keccak256, toHex } from "../src/chain/keccak";

function hashHex(s: string): string {
  return toHex(keccak256(new TextEncoder().encode(s)));
}

describe("keccak256", () => {
  it("matches the known vectors", () => {
    expect(hashHex("")).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(hashHex("abc")).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });

  it("matches viem for every input length across several blocks (the rate is 136 bytes)", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let len = 0; len <= 420; len++) {
      const bytes = Uint8Array.from({ length: len }, next);
      expect(`0x${toHex(keccak256(bytes))}`, `length ${len}`).toBe(viemKeccak(bytes));
    }
  });

  it("gives the known ERC-20 selectors", () => {
    expect(funcSelector("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect(funcSelector("approve(address,uint256)")).toBe("0x095ea7b3");
    expect(funcSelector("balanceOf(address)")).toBe("0x70a08231");
    expect(funcSelector("totalSupply()")).toBe("0x18160ddd");
  });

  it("agrees with the hardcoded selectors in abi.ts", () => {
    expect(funcSelector("name()")).toBe(SELECTORS.name);
    expect(funcSelector("symbol()")).toBe(SELECTORS.symbol);
    expect(funcSelector("decimals()")).toBe(SELECTORS.decimals);
    expect(funcSelector("totalSupply()")).toBe(SELECTORS.totalSupply);
    expect(funcSelector("balanceOf(address)")).toBe(SELECTORS.balanceOf);
    expect(funcSelector("owner()")).toBe(SELECTORS.owner);
    expect(funcSelector("getOwner()")).toBe(SELECTORS.getOwner);
    expect(funcSelector("implementation()")).toBe(SELECTORS.implementation);
  });

  it("hashes text like viem", () => {
    expect(`0x${hashHex("hyvo.sellcheck.sink")}`).toBe(viemKeccak(viemToHex("hyvo.sellcheck.sink")));
  });
});
