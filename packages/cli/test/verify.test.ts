import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORACLE } from "../src/oracle";
import { run, SAMPLE_RUN, tempDir, testContext, type Route } from "./helpers";

const API = "https://api.hyvo.run";
const RPC = "robinhood.drpc.org";
const ID = SAMPLE_RUN.runId;
const TX = `0x${"ab".repeat(32)}`;
const COMMITTED_AT = 1_793_935_412; // 2026-11-06 03:23:32 UTC

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
function commit(reportHash: string, scenarioHash: string, committedAt: number): string {
  return `0x${word(reportHash)}${word(scenarioHash)}${word("0")}${word(committedAt.toString(16))}${word("0")}${word("0")}`;
}

interface Chain {
  chainId?: string;
  result?: string;
}

function routes(opts: { file?: string; chain?: Chain; runStatus?: number; artifactStatus?: number; extraField?: boolean } = {}): Route[] {
  const summary = { ...SAMPLE_RUN.summary, publishedAt: "2026-11-02T12:30:00Z", featured: false };
  return [
    (url) => (url.origin === API && url.pathname === `/v1/runs/${ID}/artifact` ? artifact(opts) : undefined),
    (url) => (url.origin === API && url.pathname === `/v1/artifacts/${ID}/run.json` ? { body: opts.file ?? SAMPLE_RUN.text } : undefined),
    (url) =>
      url.origin === API && url.pathname === `/v1/runs/${ID}`
        ? {
            status: opts.runStatus ?? 200,
            body: {
              run: summary,
              job: null,
              oracle: { status: "confirmed", txHash: TX, blockNumber: 107_263_025, chainId: 4663, oracleAddress: ORACLE.address },
              outcome: null,
              disclaimer: "Synthetic crowd reaction. Not a trading signal.",
              ...(opts.extraField ? { somethingNew: true } : {}),
            },
          }
        : undefined,
    (url, body) => {
      if (url.host !== RPC) return undefined;
      const { method } = JSON.parse(body ?? "{}") as { method: string };
      if (method === "eth_chainId") return { body: { jsonrpc: "2.0", id: 1, result: opts.chain?.chainId ?? "0x1237" } };
      if (method === "eth_call") return { body: { jsonrpc: "2.0", id: 1, result: opts.chain?.result ?? commit(SAMPLE_RUN.meta.hash, SAMPLE_RUN.meta.scenarioHash, COMMITTED_AT) } };
      return { body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no such method" } } };
    },
  ];
}

function artifact(opts: { artifactStatus?: number }) {
  if (opts.artifactStatus) return { status: opts.artifactStatus, body: { error: { code: "not_found", message: "no such run" } } };
  return { body: { url: `${API}/v1/artifacts/${ID}/run.json?exp=1793990000&sig=${"0".repeat(64)}`, expiresAt: "2026-11-09T08:00:00Z" } };
}

describe("hyvo verify <runId>", () => {
  it("recomputes the hash, reads the pinned oracle and says verified", async () => {
    const c = testContext({ routes: routes() });
    expect(await run(["verify", ID], c)).toBe(0);
    const out = c.stdout();
    expect(out).toContain(`HYVO VERIFY   ${ID}`);
    expect(out).toContain("Thin-liquidity launch with a deployer rumor");
    expect(out).toContain(`match      run.json hashes to the hash it records\n             ${SAMPLE_RUN.meta.hash}`);
    expect(out).toContain("match      reportHash on chain is that hash");
    expect(out).toContain("match      scenarioHash on chain is the scenario's hash");
    expect(out).toContain("committed 2026-11-06 03:23:32 UTC");
    expect(out).toContain("Verified. This run.json is the one committed on Robinhood Chain.");
    expect(out).toContain(`The API records the commit in transaction ${TX}, block 107263025.`);
    expect(out.trimEnd().split("\n").at(-1)).toBe("  Synthetic crowd reaction. Not a trading signal.");

    const call = c.requests.find((r) => r.body?.includes("eth_call"))!;
    const params = (JSON.parse(call.body!) as { params: [{ to: string; data: string }, string] }).params;
    expect(params[0].to).toBe(ORACLE.address);
    expect(params[0].data).toBe(`0x8784ea96${SAMPLE_RUN.meta.runIdBytes32.slice(2)}`);
    expect(params[1]).toBe("latest");
  });

  it("prints the proof as JSON", async () => {
    const c = testContext({ routes: routes() });
    expect(await run(["verify", ID, "--json"], c)).toBe(0);
    const json = JSON.parse(c.stdout());
    expect(Object.keys(json)).toEqual(["runId", "verified", "title", "file", "chain", "api", "disclaimer"]);
    expect(json).toMatchObject({
      runId: ID,
      verified: true,
      file: { source: "api", path: null, hash: SAMPLE_RUN.meta.hash, recomputed: SAMPLE_RUN.meta.hash, matches: true, scenarioHash: SAMPLE_RUN.meta.scenarioHash },
      chain: {
        chainId: 4663,
        oracle: ORACLE.address,
        oracleFrom: "pinned",
        rpc: RPC,
        commit: { reportHash: SAMPLE_RUN.meta.hash, scenarioHash: SAMPLE_RUN.meta.scenarioHash, committedAt: COMMITTED_AT },
        reportHashMatches: true,
        scenarioHashMatches: true,
      },
      api: { host: "api.hyvo.run", oracleAddress: ORACLE.address, status: "confirmed", txHash: TX, blockNumber: 107_263_025 },
      disclaimer: "Synthetic crowd reaction. Not a trading signal.",
    });
  });

  it("is not verified, exit 1, when the chain holds another hash", async () => {
    const c = testContext({ routes: routes({ chain: { result: commit(`0x${"11".repeat(32)}`, SAMPLE_RUN.meta.scenarioHash, COMMITTED_AT) } }) });
    expect(await run(["verify", ID], c)).toBe(1);
    expect(c.stdout()).toContain("mismatch   reportHash on chain is that hash");
    expect(c.stdout()).toContain("Not verified: the chain holds another hash for this run.");
  });

  it("is not verified when only the scenario hash differs", async () => {
    const c = testContext({ routes: routes({ chain: { result: commit(SAMPLE_RUN.meta.hash, `0x${"22".repeat(32)}`, COMMITTED_AT) } }) });
    expect(await run(["verify", ID, "--json"], c)).toBe(1);
    expect(JSON.parse(c.stdout())).toMatchObject({ verified: false, chain: { reportHashMatches: true, scenarioHashMatches: false } });
  });

  it("is not verified when the run was never committed", async () => {
    const c = testContext({ routes: routes({ chain: { result: commit("0x0", "0x0", 0) } }) });
    expect(await run(["verify", ID], c)).toBe(1);
    expect(c.stdout()).toContain("missing    no commit for this run id in HyvoOracle");
    expect(c.stdout()).toContain("Not verified: Robinhood Chain holds no commit for this run id.");
  });

  it("is not verified when the file was changed after it was hashed", async () => {
    const tampered = SAMPLE_RUN.text.replace("Thin-liquidity launch", "Thick-liquidity launch");
    expect(tampered).not.toBe(SAMPLE_RUN.text);
    const c = testContext({ routes: routes({ file: tampered }) });
    expect(await run(["verify", ID, "--json"], c)).toBe(1);
    const json = JSON.parse(c.stdout());
    expect(json.file.matches).toBe(false);
    expect(json.file.hash).toBe(SAMPLE_RUN.meta.hash);
    expect(json.file.recomputed).not.toBe(SAMPLE_RUN.meta.hash);
    expect(json.verified).toBe(false);
  });

  it("still proves the run when the API's own record cannot be read", async () => {
    for (const opts of [{ runStatus: 500 }, { extraField: true }]) {
      const c = testContext({ routes: routes(opts) });
      expect(await run(["verify", ID, "--json"], c)).toBe(0);
      expect(JSON.parse(c.stdout()).api).toMatchObject({ txHash: null, oracleAddress: null });
    }
  });

  it("reads another oracle when told to, and says so", async () => {
    const other = "0x000000000000000000000000000000000000dEaD";
    const c = testContext({ routes: routes() });
    expect(await run(["verify", ID, "--oracle", other.toLowerCase(), "--json"], c)).toBe(0);
    const call = c.requests.find((r) => r.body?.includes("eth_call"))!;
    expect(JSON.parse(call.body!).params[0].to).toBe(other);
    expect(JSON.parse(c.stdout()).chain).toMatchObject({ oracle: other, oracleFrom: "option" });
  });

  it("exits 2 when there is no such run, or the RPC is another chain", async () => {
    const missing = testContext({ routes: routes({ artifactStatus: 404 }) });
    expect(await run(["verify", ID], missing)).toBe(2);
    expect(missing.stderr()).toContain(`api.hyvo.run has no published run ${ID}`);

    const wrong = testContext({ routes: routes({ chain: { chainId: "0x1" } }) });
    expect(await run(["verify", ID, "--json"], wrong)).toBe(2);
    expect(JSON.parse(wrong.stdout())).toEqual({ error: { code: "wrong_chain", message: "robinhood.drpc.org answers for chain 1, not Robinhood Chain (4663)" } });

    const noOracle = testContext({ routes: routes({ chain: { result: "0x" } }) });
    expect(await run(["verify", ID], noOracle)).toBe(2);
    expect(noOracle.stderr()).toContain("it is not a HyvoOracle");

    const offline = testContext();
    expect(await run(["verify", ID], offline)).toBe(2);
    expect(offline.stderr()).toContain("could not reach api.hyvo.run (ENOTFOUND)");
  });

  it("uses the API and RPC it is given", async () => {
    const c = testContext({ env: { HYVO_API_URL: "http://127.0.0.1:8787" } });
    await run(["verify", ID, "--rpc", "https://rpc.example/k"], c);
    expect(c.requests[0]!.url.startsWith("http://127.0.0.1:8787/v1/")).toBe(true);
    expect(c.stderr()).toContain("127.0.0.1:8787");
  });
});

describe("hyvo verify <file>", () => {
  it("checks a run.json on disk against the chain without asking the API", async () => {
    const path = join(tempDir(), "run.json");
    writeFileSync(path, SAMPLE_RUN.text);
    const c = testContext({ routes: routes() });
    expect(await run(["verify", path], c)).toBe(0);
    expect(c.requests.every((r) => new URL(r.url).host === RPC)).toBe(true);
    expect(c.stdout()).toContain(`run.json read from ${path}; the API was not asked.`);
    expect(c.stdout()).toContain("Verified.");
  });

  it("refuses what is neither a run id nor a file", async () => {
    const c = testContext();
    expect(await run(["verify", "run_123"], c)).toBe(64);
    expect(c.stderr()).toContain("not a run id (run_ and 26 characters) or a file: run_123");
  });

  it("refuses a file that is not a run", async () => {
    const path = join(tempDir(), "other.json");
    writeFileSync(path, JSON.stringify({ hello: "world" }));
    const c = testContext({ routes: routes() });
    expect(await run(["verify", path, "--json"], c)).toBe(2);
    expect(JSON.parse(c.stdout()).error.code).toBe("bad_file");
  });
});
