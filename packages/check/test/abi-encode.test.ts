import { type AbiParameter, encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { type AbiParam, encodeParameters } from "../src/chain/abi-encode";

// viem is the oracle: the from-scratch encoder must produce byte-identical output.
function same(params: AbiParam[], values: unknown[]): void {
  const ours = encodeParameters(params, values);
  const theirs = encodeAbiParameters(params as unknown as AbiParameter[], values as never);
  expect(ours).toBe(theirs);
}

const ADDR = `0x${"11".repeat(20)}`;
const ADDR2 = `0x${"22".repeat(20)}`;

describe("encodeParameters matches viem", () => {
  it("static scalars", () => {
    same([{ type: "uint256" }], [123456789n]);
    same([{ type: "uint128" }], [42n]);
    same([{ type: "uint24" }], [3000n]);
    same([{ type: "address" }], [ADDR]);
    same([{ type: "bool" }], [true]);
    same([{ type: "bool" }], [false]);
    same([{ type: "bytes32" }], [`0x${"ab".repeat(32)}`]);
    same([{ type: "bytes4" }], ["0xa0712d68"]);
  });

  it("signed ints (two's complement)", () => {
    same([{ type: "int24" }], [-887220n]);
    same([{ type: "int256" }], [-1n]);
    same([{ type: "int128" }], [12345n]);
  });

  it("several static params (head only)", () => {
    same([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [ADDR, 1000n, true]);
  });

  it("dynamic bytes and string", () => {
    same([{ type: "bytes" }], ["0x"]);
    same([{ type: "bytes" }], ["0xdeadbeef"]);
    same([{ type: "bytes" }], [`0x${"ff".repeat(40)}`]);
    same([{ type: "string" }], ["hello hyvo"]);
    same([{ type: "string" }], ["naïve ✓"]);
    same([{ type: "address" }, { type: "bytes" }, { type: "uint256" }], [ADDR, "0xc0ffee", 7n]);
  });

  it("dynamic and fixed arrays", () => {
    same([{ type: "uint256[]" }], [[1n, 2n, 3n]]);
    same([{ type: "uint256[]" }], [[]]);
    same([{ type: "address[]" }], [[ADDR, ADDR2]]);
    same([{ type: "bytes32[]" }], [[`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`]]);
    same([{ type: "uint256[2]" }], [[9n, 10n]]);
    same([{ type: "bytes[]" }], [["0xaa", "0xbbbb", "0x"]]);
  });

  it("tuples, including a V4 PoolKey and the multicall's call list", () => {
    const poolKey: AbiParam = {
      type: "tuple",
      components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    };
    same([poolKey], [["0x0000000000000000000000000000000000000000", ADDR, 3000n, 60n, ADDR2]]);
    const withDynamic: AbiParam = { type: "tuple", components: [{ type: "address" }, { type: "bytes" }, { type: "uint256[]" }] };
    same([withDynamic], [[ADDR, "0xdead", [1n, 2n]]]);
    const calls: AbiParam = { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] };
    same([calls], [[[ADDR, 1_000_000n, "0x06fdde03"], [ADDR2, 1_000_000n, `0x70a08231${"0".repeat(64)}`]]]);
  });

  it("a struct given as an object keyed by component names", () => {
    const named: AbiParam = {
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "fee", type: "uint24" },
      ],
    };
    expect(encodeParameters([named], [{ currency0: ADDR, fee: 500n }])).toBe(encodeParameters([named], [[ADDR, 500n]]));
  });
});
