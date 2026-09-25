import { Agent, type AgentOptions, buildSystemPrompt } from "./agent.ts";
import { loadCommandHooks, registerCommandHooks } from "./command-hooks.ts";
import type { Config } from "./config.ts";
import { loadInstructions, loadSkills, watchPackages } from "./context.ts";
import { type HarnessEvent, type HookResult, Hooks } from "./events.ts";
import { claudeProvider, resolveClaudeModel } from "./providers/claude.ts";
import { codexProvider } from "./providers/codex.ts";
import type { Provider, ToolSpec } from "./providers/types.ts";
import { providerFamily, type Session } from "./sessions.ts";
import { toolsFor } from "./tools/index.ts";

// Setting up a session, shared by every frontend. The frontend decides how output is shown and how
// permission is asked, the rest (provider, tools, instructions, skills, hooks, the agent) is the same.

export type PreToolUse = Extract<HarnessEvent, { type: "PreToolUse" }>;

export type Frontend = Pick<AgentOptions, "onText" | "onReasoning" | "onToolStart" | "onToolEnd" | "onStep" | "onCompact"> & {
  // Asks before an edit or a bash command runs. Returns { block } to deny. Without it everything runs (--yolo).
  askPermission?: (e: PreToolUse) => Promise<HookResult>;
  // One-line notices, like a package's AGENTS.md being picked up.
  notice?: (line: string) => void;
};

export type ProviderChoice = { provider: string; model?: string };

// codex | bedrock | anthropic. Without a flag: Bedrock if Claude Code is set up for it, the Anthropic API
// if a Claude model was asked for, else Codex over the ChatGPT login. A resumed session keeps its
// provider and model unless flags say otherwise. Throws when the flags ask for a provider the history
// can't move to.
export function chooseProvider(config: Config, flags: { provider?: string; model?: string }, resumed?: Session): ProviderChoice {
  let model = flags.model ?? config.get("HARNESS_MODEL");
  let provider =
    flags.provider ??
    config.get("HARNESS_PROVIDER") ??
    (config.get("CLAUDE_CODE_USE_BEDROCK") === "1" ? "bedrock" : /^(claude|opus|sonnet|haiku|arn:)/i.test(model ?? "") ? "anthropic" : "codex");
  if (resumed) {
    const { provider: saved, model: savedModel } = resumed;
    if (providerFamily(saved, savedModel) !== providerFamily(provider)) {
      if (flags.provider) throw new Error(`That session ran on ${saved ?? "codex"}. Its history can't move to ${provider}.`);
      provider = saved ?? "codex";
    }
    if (!flags.model && (!saved || saved === provider)) model = savedModel;
  }
  return { provider, model };
}

export function makeProvider(config: Config, { provider, model }: ProviderChoice, sessionId: string): Provider {
  if (provider === "codex") return codexProvider(model ?? "gpt-5.5", sessionId, config.get("HARNESS_EFFORT"));
  if (provider !== "bedrock" && provider !== "anthropic") {
    throw new Error(`Unknown provider "${provider}". Use codex, bedrock or anthropic.`);
  }
  const name = model ?? config.get("ANTHROPIC_MODEL") ?? config.model ?? "sonnet";
  return claudeProvider(provider, resolveClaudeModel(name, provider, config), config);
}

// Edits show their diff, bash its command and web_fetch its URL before running (a fetch can send data out).
// read_file and web_search are read-only, so they're always allowed.
const needsPermission = (e: PreToolUse) => !!e.changes || e.tool === "bash" || e.tool === "web_fetch";

export type SessionOptions = {
  config: Config;
  cwd: string;
  sessionId: string;
  choice: ProviderChoice;
  frontend: Frontend;
  // A saved session to pick up.
  resumed?: Session;
  // Advertised to the model with no implementation, to watch the "Unknown tool" path.
  fakeTools?: ToolSpec[];
};

// Builds the agent and emits SessionStart. Throws if the provider can't be set up.
export async function startSession(o: SessionOptions) {
  const { config, cwd, sessionId, frontend } = o;
  const hooks = new Hooks();
  // /model swaps the model within the session's provider.
  const providerFor = (model = o.choice.model) => makeProvider(config, { ...o.choice, model }, sessionId);
  const provider = providerFor();
  const tools = toolsFor(provider.name, provider.hostedTools.map((t) => t.name));
  // Command hooks from settings.json run before the permission prompt, so one can deny a call first.
  registerCommandHooks(hooks, await loadCommandHooks(cwd), sessionId, cwd);
  const [instructions, skills] = await Promise.all([loadInstructions(cwd), loadSkills(cwd)]);
  watchPackages(hooks, cwd, { instructions, skills }, (what) => frontend.notice?.(`Loaded ${what}`));

  const ask = frontend.askPermission;
  if (ask) {
    hooks.on("PreToolUse", async (e) => {
      if (!needsPermission(e)) return;
      await hooks.emit({ type: "Notification", message: `foxy-harness needs your permission to use ${e.tool}`, notificationType: "permission_prompt" });
      return ask(e);
    });
  }

  const agent = new Agent({
    provider,
    tools,
    hooks,
    cwd,
    sessionId,
    system: buildSystemPrompt(cwd, tools, instructions, skills, provider.hostedTools),
    contextWindow: Number(config.get("HARNESS_CONTEXT_WINDOW")) || undefined,
    maxSteps: Number(config.get("HARNESS_MAX_STEPS")) || undefined,
    fakeTools: o.fakeTools,
    onText: frontend.onText,
    onReasoning: frontend.onReasoning,
    onToolStart: frontend.onToolStart,
    onToolEnd: frontend.onToolEnd,
    onStep: frontend.onStep,
    onCompact: frontend.onCompact,
  });
  if (o.resumed) agent.restore(o.resumed.messages);
  await hooks.emit({ type: "SessionStart", sessionId, cwd, source: o.resumed ? "resume" : "startup" });
  return { agent, hooks, instructions, skills, providerFor };
}
