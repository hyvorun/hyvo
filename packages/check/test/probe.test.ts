import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROBE_RUNTIME, PROBE_SOURCE_SHA256 } from "../src/probe/index";
import probe from "../src/probe/sellcheck.json" with { type: "json" };

const chainDir = new URL("../../../chain/", import.meta.url);
const source = new URL("src/probes/SellCheck.sol", chainDir);
const forgeOutput = new URL("out/SellCheck.sol/SellCheck.json", chainDir);

describe("the exported SellCheck probe", () => {
  it("was exported from the current Solidity source (run `forge build` and the export script after editing it)", () => {
    const text = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text).digest("hex")).toBe(PROBE_SOURCE_SHA256);
  });

  it.skipIf(!existsSync(forgeOutput))("matches forge's build of it, byte for byte", () => {
    const out = JSON.parse(readFileSync(forgeOutput, "utf8"));
    expect(PROBE_RUNTIME).toBe(String(out.deployedBytecode.object).toLowerCase());
    expect(probe.abi).toEqual(out.abi);
    expect(probe.compiler).toBe(out.metadata.compiler.version);
  });

  it("is runtime code with the four checks and the V4 callback", () => {
    expect(PROBE_RUNTIME).toMatch(/^0x([0-9a-f]{2})+$/);
    const names = probe.abi.filter((x) => x.type === "function").map((x) => x.name);
    expect(names.sort()).toEqual(["checkPonsCurve", "checkV2", "checkV3", "checkV4", "unlockCallback"]);
    expect(probe.compiler).toBe("0.8.28+commit.7893614a");
    expect(probe.evmVersion).toBe("shanghai");
  });
});
