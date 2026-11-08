import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, toRequest } from "../src/lib/draft";
import { lastEventRound, TEMPLATES } from "../src/lib/templates";

describe("scenario templates", () => {
  it.each(TEMPLATES.map((template) => [template.id, template] as const))("%s fills a form the API accepts", (_, template) => {
    const { request, errors } = toRequest({ ...EMPTY_DRAFT, ...template.draft });
    expect(errors).toEqual({});
    expect(request?.scenario.title).toBe(template.draft.title);
    expect(request?.scenario.market?.tokenSymbol).toBe(template.draft.tokenSymbol);
    expect(lastEventRound(template)).toBeLessThanOrEqual(Number(EMPTY_DRAFT.rounds));
  });

  it("uses fictional tokens only, with unique ids and symbols", () => {
    expect(new Set(TEMPLATES.map((template) => template.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((template) => template.draft.tokenSymbol)).size).toBe(TEMPLATES.length);
    for (const template of TEMPLATES) {
      expect(template.draft.title.toLowerCase()).toContain("fictional");
      expect(template.draft.tokenName).toMatch(/\(fictional\)$/);
    }
  });
});
