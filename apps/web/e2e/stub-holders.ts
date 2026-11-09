/**
 * A stubbed `GET /v1/check/:token/holders` on Hyvo's API (http://api.test, the app's VITE_API_URL in
 * playwright.config.ts): the token's holders and creator from Blockscout's index, as the API answers them.
 * Nothing reaches a network, and no key is involved: the real one lives only in the API Worker.
 */
import type { Page } from "@playwright/test";
import { getAddress } from "viem";
import { OWNER, PAIR, TOKEN } from "./stub-check";

export const HOLDER = getAddress("0x1111111111111111111111111111111111111aaa");
export const CREATION_TX = `0x${"cd".repeat(32)}`;
export const READ_AT = "2026-11-09T07:12:00Z";
export const SOURCE = "Blockscout's index, read through Hyvo's API at 07:12 UTC on 2026-11-09";

/** The API's answer: the pair (pool liquidity), one holder and the deployer, of a supply of 10^27. */
export const FACTS = {
  token: TOKEN,
  source: SOURCE,
  totalSupply: (10n ** 27n).toString(),
  holderCount: 3,
  holders: [
    { address: PAIR, value: (5n * 10n ** 26n).toString() },
    { address: HOLDER, value: (2n * 10n ** 26n).toString() },
    { address: OWNER, value: (10n ** 26n).toString() },
  ],
  holdersMissing: null,
  creator: { address: OWNER, creationTxHash: CREATION_TX },
  creatorMissing: null,
  readAt: READ_AT,
  disclaimer: `Read from Blockscout's index through Hyvo's API at ${READ_AT}, not at one block. Not a trading signal.`,
};

export type HoldersAnswer = "fail" | { status: number; body: unknown };

/** Answers the holders route with `answer` ("fail": no answer at all); returns how often it was asked. */
export async function stubHolders(page: Page, answer: HoldersAnswer = { status: 200, body: FACTS }): Promise<{ asked: string[] }> {
  const log = { asked: [] as string[] };
  await page.route("http://api.test/v1/check/*/holders", async (route) => {
    log.asked.push(route.request().url());
    if (answer === "fail") return route.abort("connectionrefused");
    return route.fulfill({
      status: answer.status,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(answer.body),
    });
  });
  return log;
}
