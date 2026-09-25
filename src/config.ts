import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";

// Settings, lowest to highest precedence:
//   1. ~/.claude/settings.json "env" block, so a machine already set up for Claude Code works as is
//   2. ~/.foxy-harness/settings.json "env" block, for harness-only overrides
//   3. real environment variables
// Names match Claude Code's (ANTHROPIC_*, CLAUDE_CODE_USE_BEDROCK, AWS_*), plus HARNESS_PROVIDER and HARNESS_MODEL.
// HARNESS_MODEL_<NAME> defines a model name of your own, so HARNESS_MODEL_OPUS46=arn:... makes `/model opus46` work.
// Values are read through get() only, never copied into process.env, so bash commands don't inherit them.

export type Config = {
  get(name: string): string | undefined;
  model?: string;
  // Model names defined with HARNESS_MODEL_<NAME>, lowercased, to what each one stands for.
  aliases: Record<string, string>;
};

const ALIAS = /^HARNESS_MODEL_(.+)$/;

export async function loadConfig(): Promise<Config> {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const env: Record<string, string> = {};
  let model: string | undefined;

  for (const path of [join(claudeDir, "settings.json"), join(HARNESS_HOME, "settings.json")]) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    try {
      const json = (await file.json()) as { env?: Record<string, string>; model?: string };
      Object.assign(env, json.env);
      model = json.model ?? model;
    } catch (err) {
      console.error(`foxy-harness: skipping ${path} (${err})`);
    }
  }
  const get = (name: string) => process.env[name] || env[name] || undefined;
  const aliases: Record<string, string> = {};
  for (const key of new Set([...Object.keys(env), ...Object.keys(process.env)])) {
    const name = ALIAS.exec(key)?.[1];
    const value = get(key);
    if (name && value) aliases[name.toLowerCase()] = value;
  }
  return { get, model, aliases };
}
