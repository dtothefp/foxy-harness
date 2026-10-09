import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAuth, hasLogin, ORIGINATOR } from "../auth/codex-oauth.ts";
import type { Config } from "../config.ts";

// Where Codex requests go and how they're signed. Three ways in, first match wins:
//   1. A custom provider picked in Codex CLI's config.toml (`model_provider = "x"` with a [model_providers.x]
//      block), like a company gateway or Azure. Same keys as Codex CLI, so a machine set up for Codex works as is.
//   2. The ChatGPT login (`foxy-harness login`), unless OPENAI_BASE_URL says otherwise.
//   3. An API key, OPENAI_API_KEY or the one `codex login --with-api-key` saved in ~/.codex/auth.json,
//      against OPENAI_BASE_URL (default the OpenAI API).
// The URL and key are read here and never logged or saved.

const CHATGPT = "https://chatgpt.com/backend-api/codex";
const OPENAI = "https://api.openai.com/v1";

export type Endpoint = {
  chatgpt: boolean;
  url(path: string): string;
  headers(forceRefresh?: boolean): Promise<Record<string, string>>;
  // Codex CLI's default model, used when no model was asked for.
  model?: string;
};

type ProviderBlock = {
  name?: string;
  base_url?: string;
  env_key?: string;
  wire_api?: string;
  query_params?: Record<string, string>;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
};
type CodexToml = { model?: string; model_provider?: string; model_providers?: Record<string, ProviderBlock> };

export function resolveEndpoint(config: Config): Endpoint {
  const home = config.get("CODEX_HOME") ?? join(homedir(), ".codex");
  const toml = readToml(join(home, "config.toml"));
  const custom = toml.model_provider && toml.model_provider !== "openai" ? toml.model_providers?.[toml.model_provider] : undefined;

  if (custom) {
    const id = toml.model_provider!;
    if (!custom.base_url) throw new Error(`Codex provider "${id}" has no base_url in ${home}/config.toml.`);
    if (custom.wire_api && custom.wire_api !== "responses")
      throw new Error(`Codex provider "${id}" uses wire_api = "${custom.wire_api}". foxy-harness only speaks the Responses API.`);
    const key = custom.env_key ? config.get(custom.env_key) : undefined;
    if (custom.env_key && !key) throw new Error(`Codex provider "${id}" needs ${custom.env_key} set.`);
    const extra = { ...custom.http_headers };
    for (const [header, env] of Object.entries(custom.env_http_headers ?? {})) {
      const value = config.get(env);
      if (value) extra[header] = value;
    }
    return apiKey(custom.base_url, key, toml.model, custom.query_params, extra);
  }

  const base = config.get("OPENAI_BASE_URL");
  if (hasLogin() && !base) return chatgpt();
  const key = config.get("OPENAI_API_KEY") ?? readJson(join(home, "auth.json")).OPENAI_API_KEY;
  if (key) return apiKey(base ?? OPENAI, key, toml.model);
  return chatgpt();
}

function chatgpt(): Endpoint {
  return {
    chatgpt: true,
    url: (path) => `${CHATGPT}${path}`,
    async headers(forceRefresh) {
      const auth = await getAuth({ forceRefresh });
      return {
        Authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: ORIGINATOR,
      };
    },
  };
}

function apiKey(
  base: string,
  key: string | undefined,
  model: string | undefined,
  query: Record<string, string> = {},
  extra: Record<string, string> = {},
): Endpoint {
  const qs = new URLSearchParams(query).toString();
  return {
    chatgpt: false,
    url: (path) => `${base.replace(/\/+$/, "")}${path}${qs ? `?${qs}` : ""}`,
    headers: async () => ({ ...(key ? { Authorization: `Bearer ${key}` } : {}), originator: ORIGINATOR, ...extra }),
    model,
  };
}

function readToml(path: string): CodexToml {
  if (!existsSync(path)) return {};
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8")) as CodexToml;
  } catch (err) {
    console.error(`foxy-harness: skipping ${path} (${err})`);
    return {};
  }
}

function readJson(path: string): Record<string, string | undefined> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
