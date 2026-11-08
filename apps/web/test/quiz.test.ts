import { PERSONAS } from "@hyvo/schema";
import { describe, expect, it } from "vitest";
import { isArchetype, PROFILES } from "../src/lib/archetypes";
import { QUESTIONS, scoreQuiz } from "../src/lib/quiz";

describe("quiz", () => {
  it("gives every archetype exactly five answers, and at most one per question", () => {
    for (const persona of PERSONAS) {
      const answers = QUESTIONS.flatMap((question) => question.options.filter((option) => option.persona === persona));
      expect(answers, persona).toHaveLength(5);
    }
    for (const question of QUESTIONS) {
      expect(new Set(question.options.map((option) => option.persona)).size).toBe(question.options.length);
    }
  });

  it("lets anyone become any archetype", () => {
    for (const persona of PERSONAS) {
      // Their answer where there is one, and otherwise answers that each point somewhere new.
      const used = new Set<string>();
      const answers = QUESTIONS.map((question) => {
        const own = question.options.findIndex((option) => option.persona === persona);
        if (own >= 0) return own;
        const fresh = question.options.findIndex((option) => !used.has(option.persona) && option.persona !== persona);
        used.add(question.options[fresh]!.persona);
        return fresh;
      });
      expect(scoreQuiz(answers)?.winner).toBe(persona);
    }
  });

  it("settles a tie by the later answer", () => {
    const answersFor = (personas: string[]) =>
      personas.map((persona, index) => {
        const answer = QUESTIONS[index]!.options.findIndex((option) => option.persona === persona);
        expect(answer, `question ${index + 1} has no ${persona}`).toBeGreaterThanOrEqual(0);
        return answer;
      });
    // Two answers each for the sniper and the skeptic, one for everyone else.
    const skepticLast = answersFor(["sniper", "holder", "sniper", "skeptic", "whale", "newcomer", "kol_follower", "stock_token_holder", "market_maker_bot", "skeptic"]);
    expect(scoreQuiz(skepticLast)?.winner).toBe("skeptic");
    const sniperLast = answersFor(["skeptic", "holder", "panic_seller", "skeptic", "whale", "newcomer", "sniper", "sniper", "market_maker_bot", "swing_trader"]);
    expect(scoreQuiz(sniperLast)?.winner).toBe("sniper");
  });

  it("ranks the archetypes it points at, the winner first", () => {
    const answers = QUESTIONS.map((question) => Math.max(0, question.options.findIndex((option) => option.persona === "sniper")));
    const result = scoreQuiz(answers)!;
    expect(result.winner).toBe("sniper");
    expect(result.ranking[0]).toEqual({ persona: "sniper", count: 5 });
    expect(result.ranking.reduce((sum, row) => sum + row.count, 0)).toBe(QUESTIONS.length);
  });

  it("refuses answers that do not fit the questions", () => {
    expect(scoreQuiz([0, 1])).toBeNull();
    expect(scoreQuiz(QUESTIONS.map(() => 9))).toBeNull();
  });

  it("has a profile for every archetype and recognizes the ids", () => {
    for (const persona of PERSONAS) expect(PROFILES[persona].id).toBe(persona);
    expect(isArchetype("whale")).toBe(true);
    expect(isArchetype("clone")).toBe(false);
    expect(isArchetype(null)).toBe(false);
  });
});
