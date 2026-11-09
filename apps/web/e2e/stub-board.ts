/**
 * Robinhood Chain for the Board tests: the demo Pons world with balances and launch-second buys
 * (@hyvo/launches/testing boardDemoChain), served at http://rpc.test like stub-launches.ts. Nothing
 * leaves the test machine.
 */
import { boardDemoChain, type EndpointRules, type FakeChain } from "@hyvo/launches/testing";
import type { Page } from "@playwright/test";

const RPC = "http://rpc.test";

export async function stubBoardChain(page: Page, rules: EndpointRules = {}): Promise<FakeChain> {
  const chain = boardDemoChain({ [RPC]: rules });
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST",
  };
  await page.route(`${RPC}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (rules.down) return route.abort("connectionrefused");
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: chain.answerText(request.url(), request.postData() ?? "{}") });
  });
  return chain;
}
