import { noExtra, parseArgs, UsageError, type OptionSpec } from "../args.js";
import { httpUrl, loadSettings, maskUrl, resolveApi, resolveRpc, saveSettings, settingsPath, type Resolved, type Settings } from "../config.js";
import type { Context } from "../context.js";
import { EXIT } from "./common.js";

export const CONFIG_HELP = `hyvo config: where hyvo reads from

USAGE
  hyvo config                     Show the RPC and API in use, and where each comes from
  hyvo config set rpc <url>       Use your own Robinhood Chain JSON-RPC endpoint
  hyvo config set api <url>       Use another Hyvo API (for example a local one)
  hyvo config unset rpc|api       Go back to the default
  hyvo config reset               Remove every setting
  hyvo config path                Print where the settings file is

The environment overrides the file: HYVO_RPC_URL, HYVO_API_URL. An option (--rpc, --api) overrides both.
HYVO_BLOCKSCOUT_KEY, when set, lets hyvo check read the top holders; it is never written to the file.
`;

const OPTIONS: OptionSpec = { json: { type: "boolean" }, help: { type: "boolean", short: "h" } };

const KEYS = { rpc: "rpcUrl", api: "apiUrl" } as const;

const FROM: Record<Resolved["from"], string> = { option: "option", environment: "environment", settings: "settings file", default: "default" };

/** A path or query can hold an API key, so neither is printed. */
function describe(r: Resolved): string {
  return `${maskUrl(r.url)}  (${FROM[r.from]})`;
}

export function runConfig(argv: readonly string[], ctx: Context): number {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(CONFIG_HELP);
    return EXIT.ok;
  }
  const dir = ctx.configDir;
  const sub = positional[0] ?? "show";
  const show = (): void => {
    const settings = loadSettings(dir);
    const rpc = resolveRpc(undefined, ctx.env, settings);
    const api = resolveApi(undefined, ctx.env, settings);
    if (options.json) {
      const shown = (r: Resolved) => ({ url: maskUrl(r.url), from: r.from });
      ctx.out(`${JSON.stringify({ rpc: shown(rpc), api: shown(api), blockscoutKey: Boolean(ctx.env.HYVO_BLOCKSCOUT_KEY), file: settingsPath(dir) }, null, 2)}\n`);
      return;
    }
    ctx.out(
      `rpc        ${describe(rpc)}\napi        ${describe(api)}\nblockscout ${ctx.env.HYVO_BLOCKSCOUT_KEY ? "key set (HYVO_BLOCKSCOUT_KEY)" : "no key: hyvo check skips the top holders"}\nfile       ${settingsPath(dir)}\n`,
    );
  };

  switch (sub) {
    case "show":
      noExtra(positional, 1);
      show();
      return EXIT.ok;
    case "path":
      noExtra(positional, 1);
      ctx.out(`${settingsPath(dir)}\n`);
      return EXIT.ok;
    case "reset":
      noExtra(positional, 1);
      saveSettings(dir, {});
      show();
      return EXIT.ok;
    case "set":
    case "unset": {
      const key = positional[1];
      if (key !== "rpc" && key !== "api") throw new UsageError(`hyvo config ${sub} takes rpc or api`);
      const settings: Settings = loadSettings(dir);
      if (sub === "set") {
        const value = positional[2];
        if (!value) throw new UsageError(`missing <url> for ${key}`);
        noExtra(positional, 3);
        settings[KEYS[key]] = httpUrl(value, key === "rpc" ? "the RPC URL" : "the API URL");
      } else {
        noExtra(positional, 2);
        delete settings[KEYS[key]];
      }
      saveSettings(dir, settings);
      show();
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown config command: ${sub}`);
  }
}
