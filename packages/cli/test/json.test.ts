import { CheckError } from "@hyvo/check";
import { describe, expect, it } from "vitest";
import { run, sampleReport, testContext, TOKEN } from "./helpers";

async function checkJsonOutput() {
  const c = testContext({ checkToken: async () => sampleReport() });
  const code = await run(["check", TOKEN, "--json"], c);
  return { code, json: JSON.parse(c.stdout()) as Record<string, any>, stderr: c.stderr() };
}

describe("hyvo check --json", () => {
  it("prints one JSON document: the report as @hyvo/check serializes it, and the disclaimer", async () => {
    const { code, json, stderr } = await checkJsonOutput();
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(Object.keys(json)).toEqual(["chainId", "token", "block", "findings", "exit", "code", "timings", "notice", "disclaimer"]);
    expect(json.disclaimer).toBe("Measured on-chain at block 107512345. Not a trading signal.");
    expect(json.notice).toBe("Facts read from Robinhood Chain at one block, each with its evidence. Not a trading signal, and not an audit.");
  });

  it("carries every amount as a decimal string, never a float", async () => {
    const { json } = await checkJsonOutput();
    expect(json.block).toBe("107512345");
    expect(json.token.totalSupply).toBe("1000000000000000000000000");
    expect(json.exit.ethIn).toBe("1000000000000000");
    expect(json.exit.buy).toEqual({ ok: true, promised: "79830000000000000000", arrived: "79830000000000000000", shortfallPct: 0, gas: "133547", reason: null });
    expect(json.exit.transfer.gas).toBeNull();
    expect(json.exit.roundTrip).toEqual({ spent: "900000000000000", back: "894600000000000", lossPct: 0.6 });
  });

  it("lists the eleven findings by stable id, each with a status and evidence", async () => {
    const { json } = await checkJsonOutput();
    expect(json.findings.map((f: { id: string }) => f.id)).toEqual([
      "source",
      "owner",
      "proxy",
      "mint",
      "fee-setter",
      "blocklist",
      "pause",
      "venue",
      "sell-simulation",
      "holders",
      "deployer",
    ]);
    for (const f of json.findings) {
      expect(Object.keys(f)).toEqual(["id", "title", "status", "evidence"]);
      expect(["found", "not_found", "skipped"]).toContain(f.status);
      expect(f.evidence.length).toBeGreaterThan(0);
    }
    expect(json).not.toHaveProperty("verdict");
  });

  it("keeps exit null when there was no simulation", async () => {
    const c = testContext({ checkToken: async () => sampleReport({ exit: null }) });
    await run(["check", TOKEN, "--json"], c);
    expect(JSON.parse(c.stdout()).exit).toBeNull();
  });

  it("answers a failure as a JSON error on stdout, exit 2", async () => {
    const c = testContext({
      checkToken: async () => {
        throw new CheckError("not_a_contract", `${TOKEN} has no code at block 1: it is not a contract`);
      },
    });
    expect(await run(["check", TOKEN, "--json"], c)).toBe(2);
    expect(JSON.parse(c.stdout())).toEqual({ error: { code: "not_a_contract", message: `${TOKEN} has no code at block 1: it is not a contract` } });
  });
});
