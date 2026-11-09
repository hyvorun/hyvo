import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, DEFAULT_API_URL, DEFAULT_RPC_URL, loadSettings, maskUrl, resolveApi, resolveRpc, settingsPath } from "../src/config";
import { run, testContext } from "./helpers";

describe("where hyvo reads from", () => {
  it("prefers the option, then the environment, then the settings file, then the default", () => {
    const env = { HYVO_RPC_URL: "https://env.example" };
    const settings = { rpcUrl: "https://file.example" };
    expect(resolveRpc("https://opt.example", env, settings)).toEqual({ url: "https://opt.example", from: "option" });
    expect(resolveRpc(undefined, env, settings)).toEqual({ url: "https://env.example", from: "environment" });
    expect(resolveRpc(undefined, {}, settings)).toEqual({ url: "https://file.example", from: "settings" });
    expect(resolveRpc(undefined, {}, {})).toEqual({ url: DEFAULT_RPC_URL, from: "default" });
    expect(DEFAULT_RPC_URL).toBe("https://robinhood.drpc.org");
    expect(resolveApi(undefined, {}, {})).toEqual({ url: DEFAULT_API_URL, from: "default" });
    expect(DEFAULT_API_URL).toBe("https://api.hyvo.run");
  });

  it("refuses a URL that is not http(s)", () => {
    expect(() => resolveRpc("file:///etc/passwd", {}, {})).toThrow(/must be an http\(s\) URL/);
    expect(() => resolveApi(undefined, { HYVO_API_URL: "ftp://x" }, {})).toThrow(/must be an http\(s\) URL/);
  });

  it("keeps its settings in HYVO_CONFIG_DIR, XDG_CONFIG_HOME or the platform's place", () => {
    expect(configDir({ HYVO_CONFIG_DIR: "/tmp/h" })).toBe("/tmp/h");
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "hyvo"));
    expect(configDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")).toBe(join("C:\\Users\\u\\AppData\\Roaming", "hyvo"));
  });

  it("never prints a URL's path or query, where a key can hide", () => {
    expect(maskUrl("https://robinhood.drpc.org")).toBe("https://robinhood.drpc.org");
    expect(maskUrl("https://robinhood.drpc.org/")).toBe("https://robinhood.drpc.org");
    expect(maskUrl("https://lb.drpc.org/ogrpc?network=robinhood&dkey=SECRET")).toBe("https://lb.drpc.org/…");
  });

  it("reads a broken settings file as no settings", () => {
    const c = testContext();
    writeFileSync(settingsPath(c.ctx.configDir), "{ not json");
    expect(loadSettings(c.ctx.configDir)).toEqual({});
    writeFileSync(settingsPath(c.ctx.configDir), JSON.stringify({ rpcUrl: "javascript:alert(1)", apiUrl: "http://127.0.0.1:8787" }));
    expect(loadSettings(c.ctx.configDir)).toEqual({ apiUrl: "http://127.0.0.1:8787" });
  });
});

describe("hyvo config", () => {
  it("sets, shows and unsets the RPC, keeping keys out of what it prints", async () => {
    const c = testContext();
    expect(await run(["config", "set", "rpc", "https://lb.drpc.org/ogrpc?dkey=SECRET"], c)).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath(c.ctx.configDir), "utf8"))).toEqual({ rpcUrl: "https://lb.drpc.org/ogrpc?dkey=SECRET" });
    expect(c.stdout()).toContain("rpc        https://lb.drpc.org/…  (settings file)");
    expect(c.stdout()).not.toContain("SECRET");

    const unset = testContext({ configDir: c.ctx.configDir });
    await run(["config", "unset", "rpc"], unset);
    expect(unset.stdout()).toContain("rpc        https://robinhood.drpc.org  (default)");
  });

  it("says whether a Blockscout key is set, never the key", async () => {
    const c = testContext({ env: { HYVO_BLOCKSCOUT_KEY: "bs-SECRET" } });
    await run(["config", "--json"], c);
    const json = JSON.parse(c.stdout());
    expect(json.blockscoutKey).toBe(true);
    expect(c.stdout()).not.toContain("bs-SECRET");
  });

  it("refuses unknown settings and bad URLs", async () => {
    for (const argv of [["config", "set", "key", "x"], ["config", "set", "rpc", "not a url"], ["config", "set", "api"], ["config", "nope"]]) {
      const c = testContext();
      expect(await run(argv, c), argv.join(" ")).toBe(64);
    }
  });
});
