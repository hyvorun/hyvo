/**
 * Robinhood Chain for the Launches tests: the fictional Pons world of @hyvo/launches/testing served at
 * http://rpc.test (the app's VITE_RPC_URLS in playwright.config.ts), with whatever limits a test
 * gives the endpoint. Nothing leaves the test machine.
 */
import { demoChain, type EndpointRules, type FakeChain } from "@hyvo/launches/testing";
import type { Page } from "@playwright/test";

const RPC = "http://rpc.test";

export async function stubLaunchChain(page: Page, rules: EndpointRules = {}): Promise<FakeChain> {
  const chain = demoChain({ [RPC]: rules });
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST",
  };
  await page.route(`${RPC}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (rules.down) return route.abort("connectionrefused");
    if (rules.rateLimited) return route.fulfill({ status: 429, headers, body: "Too Many Requests" });
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: chain.answerText(request.url(), request.postData() ?? "{}") });
  });
  return chain;
}
