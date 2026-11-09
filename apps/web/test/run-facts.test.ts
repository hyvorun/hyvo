import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunV1 } from "@hyvo/schema";
import { describe, expect, it } from "vitest";
import { blocksBetween, crowdMix, personaCounts, postsRemoved, runFacts, withoutCitations } from "../src/lib/run-facts";
import { capabilityStatus } from "../src/pages/home/Capabilities";

const golden = RunV1.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)), "utf8")),
);

describe("runFacts on the golden run", () => {
  const facts = runFacts(golden);

  it("counts one decision per agent per round", () => {
    expect(facts.decisions).toBe(golden.crowd.size * golden.rounds.length);
  });

  it("counts executed swaps by side, and reverted ones apart", () => {
    const actions = golden.rounds.flatMap((round) => round.actions);
    expect(facts.buys).toBe(actions.filter((a) => a.kind === "swap_buy" && a.status === "ok").length);
    expect(facts.sells).toBe(actions.filter((a) => a.kind === "swap_sell" && a.status === "ok").length);
    expect(facts.reverted).toBe(actions.filter((a) => a.status === "reverted").length);
    expect(facts.buys + facts.sells + facts.reverted).toBeLessThanOrEqual(facts.decisions);
  });

  it("counts the same posts as the published summary", () => {
    expect(facts.posts).toBe(golden.rounds.reduce((sum, round) => sum + round.posts.length, 0));
    expect(facts.removedPosts).toBe(0);
  });
});

describe("postsRemoved", () => {
  it("reads the copy guard's flag and ignores the others", () => {
    expect(postsRemoved(["posts_removed:12"])).toBe(12);
    expect(postsRemoved(["rewritten:advice_modal", "posts_removed:1", "redacted:price_prediction"])).toBe(1);
    expect(postsRemoved([])).toBe(0);
    expect(postsRemoved(["posts_removed:", "posts_removed:x", "posts_removed:-3"])).toBe(0);
  });
});

describe("the crowd", () => {
  it("lists the mix in the order archetypes are known, lower case mid-sentence", () => {
    expect(crowdMix(golden)).toBe("10 snipers, 15 holders, 10 panic sellers and 15 skeptics");
  });

  it("counts who sat in the run", () => {
    const seated = personaCounts(golden);
    expect(Object.fromEntries(seated)).toEqual({ sniper: 10, holder: 15, panic_seller: 10, skeptic: 15 });
  });
});

describe("withoutCitations", () => {
  it("takes the post ids out of a report line", () => {
    expect(withoutCitations("concerns about the tax structure (p13, c15, c40)")).toBe("concerns about the tax structure");
    expect(withoutCitations("lack of transparency (p2, p17, c4)")).toBe("lack of transparency");
    expect(withoutCitations("Skeptic a20 in round 5: \"Concentration risk is not a theory.\" (p52)")).toBe(
      "Skeptic a20 in round 5: \"Concentration risk is not a theory.\"",
    );
    expect(withoutCitations("no citation here")).toBe("no citation here");
  });
});

describe("blocksBetween", () => {
  it("is the gap between the fork and the commit, when both are known", () => {
    expect(blocksBetween(107_254_579, 107_263_025)).toBe(8_446);
    expect(blocksBetween(null, 107_263_025)).toBeNull();
    expect(blocksBetween(107_254_579, null)).toBeNull();
    expect(blocksBetween(10, 9)).toBeNull();
  });
});

describe("capabilityStatus", () => {
  const closed = { payments: false, oracle: true, holder: false, clone: false };
  const open = { payments: true, oracle: true, holder: true, clone: true };

  it("says what is open from the API's switches", () => {
    expect(capabilityStatus("always", null)).toEqual({ tone: "live", text: "Live" });
    expect(capabilityStatus("payments", closed)).toEqual({ tone: "later", text: "Opens with paid runs" });
    expect(capabilityStatus("payments", open)).toEqual({ tone: "live", text: "Live" });
    expect(capabilityStatus("oracle", closed)).toEqual({ tone: "live", text: "Live" });
    expect(capabilityStatus("read", closed)).toEqual({ tone: "live", text: "Live for reading" });
    expect(capabilityStatus("read", open)).toEqual({ tone: "live", text: "Live" });
  });

  it("keeps Wallet Clone closed until its switch is on, and waits for payments after that", () => {
    expect(capabilityStatus("clone", closed)).toEqual({ tone: "later", text: "Not open yet" });
    expect(capabilityStatus("clone", { ...closed, clone: true })).toEqual({ tone: "later", text: "Opens with paid runs" });
    expect(capabilityStatus("clone", open)).toEqual({ tone: "live", text: "Live" });
  });

  it("claims nothing before the API answers", () => {
    expect(capabilityStatus("payments", null)).toBeNull();
    expect(capabilityStatus("clone", null)).toBeNull();
  });
});
