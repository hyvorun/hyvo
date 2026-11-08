import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, RunV1, summarizeRun, verifyRunHash } from "../src/index";

const showcase = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/showcase-run.json", import.meta.url)), "utf8"),
);

describe("the showcase run (fixtures/showcase-run.json)", () => {
  it("is a valid RunV1 whose hash verifies", () => {
    expect(RunV1.safeParse(showcase).error?.issues).toBeUndefined();
    expect(verifyRunHash(showcase).ok).toBe(true);
  });

  it("was played to the end by a language model and carries the disclaimer", () => {
    expect(showcase.status).toBe("complete");
    expect(showcase.crowd.model.agents).not.toMatch(/^offline\//);
    expect(showcase.crowd.model.report).not.toMatch(/^offline\//);
    expect(showcase.report.disclaimer).toBe(DISCLAIMER);
  });

  it("played on a fork of the chain, with the crowd answering each other", () => {
    expect(showcase.world.chainId).toBe(4663);
    expect(showcase.world.forkBlock).toBeGreaterThan(0);
    const posts: { replyTo: string | null }[] = showcase.rounds.flatMap((round: { posts: { replyTo: string | null }[] }) => round.posts);
    expect(posts.filter((post) => post.replyTo !== null).length).toBeGreaterThan(20);
  });
});

describe("a run with every kind of trader (fixtures/ten-personas-run.json)", () => {
  const ten = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/ten-personas-run.json", import.meta.url)), "utf8"));

  it("is a valid RunV1 whose hash verifies", () => {
    expect(RunV1.safeParse(ten).error?.issues).toBeUndefined();
    expect(verifyRunHash(ten).ok).toBe(true);
  });

  it("summarizes with its whole mix", () => {
    expect(summarizeRun(RunV1.parse(ten)).personaMix).toMatchObject({ whale: 2, newcomer: 2, market_maker_bot: 2 });
  });
});
