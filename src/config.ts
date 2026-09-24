import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";

// Settings, lowest to highest precedence:
//   1. ~/.claude/settings.json "env" block, so a machine already set up for Claude Code works as is
//   2. ~/.foxy-harness/settings.json "env" block, for harness-only overrides
//   3. real environment variables
// Names match Claude Code's (ANTHROPIC_*, CLAUDE_CODE_USE_BEDROCK, AWS_*), plus HARNESS_PROVIDER and HARNESS_MODEL.
// Values are read through get() only, never copied into process.env, so bash commands don't inherit them.

export type Config = { get(name: string): string | undefined; model?: string };

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
  return { get: (name) => process.env[name] || env[name] || undefined, model };
}
