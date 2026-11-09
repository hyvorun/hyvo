import { describe, expect, it } from "vitest";
import { funcSelector, shortenAddress, strip0x, toChecksumAddress } from "../src/chain/abi";
import { blacklistCheck } from "../src/checks/blacklist";
import type { CheckContext, CodeTarget, OwnerState } from "../src/checks/context";
import { detectFunctions } from "../src/checks/detect";
import { holdersCheck } from "../src/checks/holders";
import { MINT, mintCheck } from "../src/checks/mint";
import { FEE_SETTER, mutableFeeCheck } from "../src/checks/mutable-fee";
import { originCheck } from "../src/checks/origin";
import { ownershipCheck, parseOwner } from "../src/checks/ownership";
import { pausableCheck } from "../src/checks/pausable";
import { cloneTarget, proxyCheck, readProxy } from "../src/checks/proxy";
import { verifiedCheck } from "../src/checks/verified";
import { PONS_V2 } from "../src/registry/launchpads";
import type { Address, Hex } from "../src/types";

const TOKEN = `0x${"1".repeat(40)}` as Address;
const OWNER = toChecksumAddress("0xabc9000000000000000000000000000000000f21");
const ACTIVE: OwnerState = { state: "active", address: OWNER, via: "owner()" };
const RENOUNCED: OwnerState = { state: "renounced", address: "0x0000000000000000000000000000000000000000", via: "owner()" };
const word = (hex: string) => `0x${hex.padStart(64, "0")}`;

function code(over: Partial<CodeTarget> = {}): CodeTarget {
  return { address: TOKEN, bytecode: "0x", abi: null, abiSource: null, via: "token", ...over };
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return { token: TOKEN, owner: ACTIVE, code: code(), ...over };
}

const push4 = (sig: string) => `63${strip0x(funcSelector(sig))}`;

describe("function detection", () => {
  it("finds a selector in bytecode through the PUSH4 dispatcher pattern", () => {
    const bytecode = `0x6080604052${push4("setFee(uint256)")}1461abcd` as Hex;
    const { found, method } = detectFunctions(code({ bytecode }), FEE_SETTER);
    expect(method).toBe("bytecode");
    expect(found.map((f) => f.label)).toEqual(["setFee(uint256)"]);
  });

  it("does not report a function on unrelated bytecode", () => {
    expect(detectFunctions(code({ bytecode: "0x6080604052348015" }), FEE_SETTER).found).toHaveLength(0);
  });

  it("finds a selector that solc pushes with PUSH3 because it starts with a zero byte", () => {
    const category = { signatures: ["zeroLead()"], abiName: /^zeroLead$/, describe: "zeroLead" };
    // Search a selector that really starts with 00 to prove the shorter push is matched.
    let sig = "";
    for (let i = 0; i < 5000 && !sig; i++) if (funcSelector(`f${i}()`).startsWith("0x00")) sig = `f${i}()`;
    const sel = strip0x(funcSelector(sig));
    const found = detectFunctions(code({ bytecode: `0x60806040${"62"}${sel.slice(2)}14` as Hex }), { ...category, signatures: [sig] });
    expect(found.found).toHaveLength(1);
  });

  it("reads the ABI when the source is verified, and skips view functions", () => {
    const abi = [
      { type: "function", name: "setTax", inputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
      { type: "function", name: "setFee", inputs: [{ type: "uint256" }], stateMutability: "view" },
    ];
    const { found, method } = detectFunctions(code({ abi, abiSource: "Sourcify" }), FEE_SETTER);
    expect(method).toBe("abi");
    expect(found.map((f) => f.label)).toEqual(["setTax(uint256)"]);
  });

  it("does not take minter() for a mint function (a known false positive)", () => {
    const abi = [{ type: "function", name: "minter", inputs: [], stateMutability: "view" }];
    expect(detectFunctions(code({ abi, abiSource: "Sourcify" }), MINT).found).toHaveLength(0);
  });

  it("still finds a real mint(address,uint256) and a Paxos-style increaseSupply", () => {
    const abi = [
      { type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
      { type: "function", name: "increaseSupply", inputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
    ];
    expect(detectFunctions(code({ abi, abiSource: "Sourcify" }), MINT).found.map((f) => f.label)).toEqual([
      "mint(address,uint256)",
      "increaseSupply(uint256)",
    ]);
  });

  it("does not take setFeeRecipient for a fee setter (it changes where fees go, not the rate)", () => {
    const abi = [{ type: "function", name: "setFeeRecipient", inputs: [{ type: "address" }], stateMutability: "nonpayable" }];
    expect(mutableFeeCheck(ctx({ code: code({ abi, abiSource: "Sourcify" }) })).status).toBe("not_found");
  });

  it("does not take excludeFromFee for a blocklist (a known false positive), and counts freeze only with an address", () => {
    const abi = [
      { type: "function", name: "excludeFromFee", inputs: [{ type: "address" }], stateMutability: "nonpayable" },
      { type: "function", name: "freeze", inputs: [], stateMutability: "nonpayable" },
    ];
    expect(blacklistCheck(ctx({ code: code({ abi, abiSource: "Sourcify" }) })).status).toBe("not_found");
    const usdgLike = [{ type: "function", name: "freeze", inputs: [{ type: "address" }], stateMutability: "nonpayable" }];
    expect(blacklistCheck(ctx({ code: code({ abi: usdgLike, abiSource: "Sourcify" }) })).status).toBe("found");
  });
});

describe("power findings", () => {
  it("state the function, its selector and the owner, never a caller", () => {
    const bytecode = `0x${push4("setFee(uint256)")}00` as Hex;
    const f = mutableFeeCheck(ctx({ code: code({ bytecode }) }));
    expect(f.status).toBe("found");
    expect(f.evidence).toContain("setFee(uint256) (0x69fe0e2d) in the bytecode's dispatcher");
    expect(f.evidence).toContain(`owner() returns ${shortenAddress(OWNER)}`);
    expect(mutableFeeCheck(ctx({ owner: RENOUNCED, code: code({ bytecode }) })).evidence).toContain("returns the zero address");
  });

  it("say where they looked when nothing was found", () => {
    const f = mintCheck(ctx({ code: code({ bytecode: "0x6080" }) }));
    expect(f.status).toBe("not_found");
    expect(f.evidence).toContain("none of mint(address,uint256)");
  });

  it("name the implementation when the token is a proxy", () => {
    const impl = "0x2222222222222222222222222222222222222222" as Address;
    const f = pausableCheck(ctx({ code: code({ address: impl, via: "eip1967", bytecode: `0x${push4("pause()")}` as Hex }) }));
    expect(f.status).toBe("found");
    expect(f.evidence).toContain("of the implementation 0x2222…2222");
  });

  it("are skipped when the code could not be read", () => {
    const f = blacklistCheck(ctx({ code: null, codeMissing: "the implementation has no code that could be read" }));
    expect(f.status).toBe("skipped");
    expect(f.evidence).toBe("the implementation has no code that could be read");
  });
});

describe("ownership", () => {
  it("parses owner() before getOwner(), and the zero address as renounced", () => {
    expect(parseOwner(word("abc9000000000000000000000000000000000f21"), null)).toMatchObject({ state: "active", via: "owner()" });
    expect(parseOwner(null, word("abc9000000000000000000000000000000000f21"))).toMatchObject({ state: "active", via: "getOwner()" });
    expect(parseOwner(word("0"), null).state).toBe("renounced");
    expect(parseOwner(null, null).state).toBe("none");
    expect(parseOwner("0x01", null).state).toBe("none");
  });

  it("reports found, not found and skipped", () => {
    expect(ownershipCheck(ACTIVE).status).toBe("found");
    expect(ownershipCheck(RENOUNCED).status).toBe("not_found");
    expect(ownershipCheck({ state: "none", address: null, via: null }).status).toBe("not_found");
    expect(ownershipCheck({ state: "unknown", address: null, via: null }, "timeout").status).toBe("skipped");
  });
});

describe("proxy", () => {
  const impl = "a".repeat(40);
  it("detects an EIP-1167 minimal clone from bytecode", () => {
    const bytecode = `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
    expect(cloneTarget(bytecode)?.toLowerCase()).toBe(`0x${impl}`);
    const f = proxyCheck(readProxy(bytecode, word("0"), word("0")));
    expect(f.status).toBe("found");
    expect(f.evidence).toContain("EIP-1167");
  });

  it("names the upgrade functions it found in the implementation", () => {
    const f = proxyCheck(readProxy("0x6080", word(impl), word("0")), undefined, {
      found: [{ label: "upgradeTo(address)", selector: "0x3659cfe6" }],
      method: "abi",
    });
    expect(f.evidence).toContain("the implementation has upgradeTo(address) (0x3659cfe6) in its verified ABI");
  });

  it("reads the EIP-1967 implementation and beacon slots", () => {
    expect(readProxy("0x6080", word(impl), word("0"))).toMatchObject({ kind: "eip1967" });
    expect(readProxy("0x6080", word("0"), word(impl))).toMatchObject({ kind: "beacon", implementation: null });
    expect(proxyCheck(readProxy("0x6080", word("0"), word("0"))).status).toBe("not_found");
    expect(proxyCheck(null, "timeout").status).toBe("skipped");
  });
});

describe("verified source", () => {
  const full = { match: "full" as const, abi: [], deployment: null, verifiedAt: "2026-08-04T17:40:43Z" };
  const none = { match: "none" as const, abi: null, deployment: null, verifiedAt: null };
  it("is found with a Sourcify match, not found without one, skipped when nobody could be asked", () => {
    expect(verifiedCheck({ address: TOKEN, sourcify: full }).status).toBe("found");
    expect(verifiedCheck({ address: TOKEN, sourcify: full }).evidence).toContain("full match");
    const notVerified = verifiedCheck({ address: TOKEN, sourcify: none });
    expect(notVerified.status).toBe("not_found");
    expect(notVerified.evidence).toContain("Blockscout was not asked (no API key)");
    expect(verifiedCheck({ address: TOKEN, sourcify: null }).status).toBe("skipped");
    expect(verifiedCheck({ address: TOKEN, sourcify: null, blockscout: { verified: true, abi: null } }).status).toBe("found");
  });

  it("for a proxy, follows the implementation", () => {
    const impl = "0x2222222222222222222222222222222222222222" as Address;
    const f = verifiedCheck({ address: TOKEN, sourcify: full }, { address: impl, sourcify: none });
    expect(f.status).toBe("not_found");
    expect(f.evidence).toMatch(/^implementation: Sourcify has no verified source for 0x2222…2222.*proxy: Sourcify holds a full match/);
  });
});

describe("holders", () => {
  const excluded = [
    { address: "0x0000000000000000000000000000000000000000" as Address, label: "burn addresses" },
    { address: "0x3333333333333333333333333333333333333333" as Address, label: "the Uniswap V2 pair" },
  ];
  it("is skipped without a Blockscout key, and says why", () => {
    const f = holdersCheck({ asked: false, totalSupply: 1000n, holderCount: null, holders: null, deployer: null, excluded });
    expect(f.status).toBe("skipped");
    expect(f.evidence).toContain("Blockscout API key");
  });

  it("leaves burn addresses and pools out of the top 10, and reads the deployer's share from the list", () => {
    const holders = [
      { address: "0x0000000000000000000000000000000000000000" as Address, value: 400n },
      { address: "0x3333333333333333333333333333333333333333" as Address, value: 300n },
      { address: TOKEN, value: 200n },
      { address: OWNER, value: 50n },
    ];
    const f = holdersCheck({ asked: true, totalSupply: 1000n, holderCount: 4, holders, deployer: OWNER, excluded });
    expect(f.status).toBe("found");
    expect(f.evidence).toContain("the 2 largest holders hold 25% of the supply");
    expect(f.evidence).toContain("leaving out burn addresses, the Uniswap V2 pair");
    expect(f.evidence).toContain(`the deployer ${shortenAddress(OWNER)} holds 5%`);
  });

  it("is skipped when Blockscout gives no holders", () => {
    expect(holdersCheck({ asked: true, totalSupply: 1000n, holderCount: null, holders: null, deployer: null, excluded }).status).toBe(
      "skipped",
    );
  });
});

describe("origin", () => {
  it("prefers the launchpad's own record, then Sourcify, then Blockscout", () => {
    const launch = { launchpad: PONS_V2, launcher: OWNER };
    const deployment = { deployer: OWNER, transactionHash: `0x${"ab".repeat(32)}`, blockNumber: 26841846n };
    expect(originCheck({ launch, sourcify: undefined, blockscout: undefined }).evidence).toContain("through Pons v2");
    expect(originCheck({ launch: null, sourcify: deployment, blockscout: undefined }).evidence).toContain("at block 26,841,846 (Sourcify)");
    expect(originCheck({ launch: null, sourcify: null, blockscout: { deployer: OWNER, creationTxHash: null } }).evidence).toContain(
      "(Blockscout)",
    );
    const unknown = originCheck({ launch: null, sourcify: null, blockscout: undefined });
    expect(unknown.status).toBe("skipped");
    expect(unknown.evidence).toContain("no Blockscout key was given");
  });
});
