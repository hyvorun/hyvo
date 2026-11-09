// Where hyvo reads from, and the one small settings file it keeps. Nothing here is a secret: the file holds at most
// an RPC URL and an API URL that the user chose. Precedence for each: the command-line option, then the
// environment, then the settings file, then the default.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROBINHOOD_CHAIN } from "@hyvo/check";
import { UsageError } from "./args.js";

export const DEFAULT_RPC_URL: string = ROBINHOOD_CHAIN.rpcUrls[0];
export const DEFAULT_API_URL = "https://api.hyvo.run";

export interface Settings {
  rpcUrl?: string;
  apiUrl?: string;
}

export type Origin = "option" | "environment" | "settings" | "default";

export interface Resolved {
  url: string;
  from: Origin;
}

/** HYVO_CONFIG_DIR, else $XDG_CONFIG_HOME/hyvo, else %APPDATA%\hyvo on Windows, else ~/.config/hyvo. */
export function configDir(env: Readonly<Record<string, string | undefined>>, platform: string = process.platform): string {
  if (env.HYVO_CONFIG_DIR) return env.HYVO_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "hyvo");
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "hyvo");
  return join(homedir(), ".config", "hyvo");
}

export function settingsPath(dir: string): string {
  return join(dir, "config.json");
}

/** The settings file, tolerantly: a missing or broken file reads as no settings. */
export function loadSettings(dir: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(dir), "utf8")) as Record<string, unknown>;
    const out: Settings = {};
    if (typeof raw.rpcUrl === "string" && isHttpUrl(raw.rpcUrl)) out.rpcUrl = raw.rpcUrl;
    if (typeof raw.apiUrl === "string" && isHttpUrl(raw.apiUrl)) out.apiUrl = raw.apiUrl;
    return out;
  } catch {
    return {};
  }
}

export function saveSettings(dir: string, settings: Settings): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The URL, or a UsageError naming where it came from. */
export function httpUrl(value: string, what: string): string {
  if (!isHttpUrl(value)) throw new UsageError(`${what} must be an http(s) URL, not ${value}`);
  return value;
}

function resolve(option: string | undefined, envValue: string | undefined, setting: string | undefined, fallback: string, what: string): Resolved {
  if (option !== undefined) return { url: httpUrl(option, what), from: "option" };
  if (envValue) return { url: httpUrl(envValue, what), from: "environment" };
  if (setting) return { url: setting, from: "settings" };
  return { url: fallback, from: "default" };
}

export function resolveRpc(option: string | undefined, env: Readonly<Record<string, string | undefined>>, settings: Settings): Resolved {
  return resolve(option, env.HYVO_RPC_URL, settings.rpcUrl, DEFAULT_RPC_URL, "the RPC URL");
}

export function resolveApi(option: string | undefined, env: Readonly<Record<string, string | undefined>>, settings: Settings): Resolved {
  return resolve(option, env.HYVO_API_URL, settings.apiUrl, DEFAULT_API_URL, "the API URL");
}

/** A URL with its path and query replaced by an ellipsis: either can hold an API key. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "") === "" && u.search === "" ? u.origin : `${u.origin}/…`;
  } catch {
    return "an invalid URL";
  }
}

/**
 * The host of a URL, for output. An RPC URL can carry an API key in its path or query, so a full URL is never
 * printed.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}
