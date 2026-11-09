import { type AbiParameter, encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { AbiDecodeError, decodeParameters, encodeFunctionCall, fn, functionSignature } from "../src/chain/abi-decode";
import type { AbiParam } from "../src/chain/abi-encode";
import probe from "../src/probe/sellcheck.json" with { type: "json" };

const ADDR = getAddress(`0x${"1a".repeat(20)}`);
const ADDR2 = getAddress(`0x${"2b".repeat(20)}`);

function roundTrip(params: AbiParam[], values: unknown[]): unknown[] {
  return decodeParameters(params, encodeAbiParameters(params as unknown as AbiParameter[], values as never));
}

describe("decodeParameters", () => {
  it("decodes what viem encodes: scalars", () => {
    expect(roundTrip([{ type: "uint256" }, { type: "int24" }, { type: "bool" }, { type: "address" }], [5n, -200n, true, ADDR])).toEqual([
      5n,
      -200n,
      true,
      ADDR,
    ]);
    expect(roundTrip([{ type: "bytes4" }, { type: "bytes32" }], ["0xa0712d68", `0x${"ab".repeat(32)}`])).toEqual([
      "0xa0712d68",
      `0x${"ab".repeat(32)}`,
    ]);
  });

  it("decodes dynamic bytes, strings and arrays", () => {
    expect(roundTrip([{ type: "bytes" }, { type: "string" }], ["0xdeadbeef", "Global Dollar"])).toEqual(["0xdeadbeef", "Global Dollar"]);
    expect(roundTrip([{ type: "uint256[]" }, { type: "address[2]" }], [[1n, 2n, 3n], [ADDR, ADDR2]])).toEqual([
      [1n, 2n, 3n],
      [ADDR, ADDR2],
    ]);
    expect(roundTrip([{ type: "bytes[]" }], [["0xaa", "0x", "0xbbbb"]])).toEqual([["0xaa", "0x", "0xbbbb"]]);
  });

  it("returns named tuples as objects and unnamed ones as arrays", () => {
    const named: AbiParam = {
      type: "tuple",
      components: [
        { name: "ok", type: "bool" },
        { name: "err", type: "bytes" },
        { name: "amount", type: "uint256" },
      ],
    };
    expect(roundTrip([named], [{ ok: false, err: "0x08c379a0", amount: 7n }])).toEqual([{ ok: false, err: "0x08c379a0", amount: 7n }]);
    const results: AbiParam = { type: "tuple[]", components: [{ type: "bool" }, { type: "uint256" }, { type: "bytes" }] };
    expect(roundTrip([{ type: "uint256" }, results], [9n, [[true, 21000n, "0x01"], [false, 0n, "0x"]]])).toEqual([
      9n,
      [
        [true, 21000n, "0x01"],
        [false, 0n, "0x"],
      ],
    ]);
  });

  it("decodes the probe's Result struct", () => {
    const item = probe.abi.find((x) => x.type === "function" && x.name === "checkV2")!;
    const outputs = item.outputs as unknown as AbiParam[];
    const result = {
      buyOk: true,
      expectedBuy: 10n,
      gotBuy: 9n,
      buyGas: 100n,
      buyErr: "0x",
      transferOk: true,
      transferSent: 1n,
      transferArrived: 1n,
      transferErr: "0x",
      approveOk: true,
      sellIn: 8n,
      expectedSell: 5n,
      sellOk: false,
      gotSell: 0n,
      sellGas: 50n,
      sellErr: "0x08c379a0",
    };
    expect(decodeParameters(outputs, encodeAbiParameters(outputs as unknown as AbiParameter[], [result] as never))).toEqual([result]);
  });

  it("rejects hostile data instead of trusting it", () => {
    expect(() => decodeParameters([{ type: "uint256" }], "0x1234")).toThrow(AbiDecodeError);
    // an offset far past the end
    expect(() => decodeParameters([{ type: "bytes" }], `0x${"f".repeat(64)}`)).toThrow(AbiDecodeError);
    // a length larger than the data
    expect(() => decodeParameters([{ type: "bytes" }], `0x${"20".padStart(64, "0")}${"ff".padStart(64, "0")}`)).toThrow(AbiDecodeError);
    // an array claiming 2^64 elements
    expect(() =>
      decodeParameters([{ type: "uint256[]" }], `0x${"20".padStart(64, "0")}${"1".padEnd(17, "0").padStart(64, "0")}`),
    ).toThrow(AbiDecodeError);
    expect(() => decodeParameters([{ type: "uint256" }], "0xzz")).toThrow(AbiDecodeError);
  });
});

describe("function calls", () => {
  it("builds the canonical signature of a function with a struct argument", () => {
    const item = probe.abi.find((x) => x.type === "function" && x.name === "checkV4")!;
    expect(functionSignature(item as never)).toBe("checkV4(address,(address,address,uint24,int24,address),bool,address,uint256)");
  });

  it("encodes every probe call exactly as viem does", () => {
    const key = ["0x0000000000000000000000000000000000000000", ADDR, 0, 200, ADDR2];
    const calls: [string, unknown[]][] = [
      ["checkV2", [ADDR, ADDR2, ADDR, 10n ** 15n]],
      ["checkPonsCurve", [ADDR, ADDR2, 10n ** 15n]],
      ["checkV3", [ADDR, ADDR2, ADDR, ADDR2, 10000, 10n ** 15n]],
      ["checkV4", [ADDR, key, true, ADDR2, 10n ** 15n]],
    ];
    for (const [name, args] of calls) {
      const item = probe.abi.find((x) => x.type === "function" && x.name === name)!;
      const theirs = (encodeFunctionData as (p: unknown) => string)({ abi: probe.abi, functionName: name, args });
      expect(encodeFunctionCall(item as never, args), name).toBe(theirs);
    }
  });

  it("parses human-readable signatures", () => {
    const item = fn("getPool(address,address,uint24)", ["address"]);
    expect(item.inputs.map((i) => i.type)).toEqual(["address", "address", "uint24"]);
    expect(encodeFunctionCall(item, [ADDR, ADDR2, 500])).toBe(
      encodeFunctionData({
        abi: [{ type: "function", name: "getPool", inputs: item.inputs as never, outputs: [], stateMutability: "view" }],
        functionName: "getPool",
        args: [ADDR, ADDR2, 500] as never,
      }),
    );
  });
});
