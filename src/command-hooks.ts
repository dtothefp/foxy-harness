import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import type { EventType, HarnessEvent, HookResult, Hooks } from "./events.ts";
import { sessionPath } from "./sessions.ts";

// Shell command hooks, configured like Claude Code's. A "hooks" block in ~/.foxy-harness/settings.json or
// .foxy-harness/settings.json in the launch directory:
//
//   { "hooks": { "PreToolUse": [{ "matcher": "bash", "hooks": [{ "type": "command", "command": "..." }] }] } }
//
// Each command gets the event as JSON on stdin (session_id, transcript_path, cwd, hook_event_name, plus the
// event's fields in Claude Code's names). Exit 2 blocks with stderr as the reason. Exit 0 may print JSON
// with decision "block", a PreToolUse permissionDecision "deny", or additionalContext. This is how session
// managers hook into Claude Code, so the same scripts work here.

type CommandHook = { type: "command"; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: CommandHook[] };
type HookConfig = Partial<Record<EventType, Matcher[]>>;

const BLOCKABLE = new Set<EventType>(["UserPromptSubmit", "PreToolUse", "PreCompact"]);

export async function loadCommandHooks(cwd: string): Promise<HookConfig> {
  const config: HookConfig = {};
  for (const path of [join(HARNESS_HOME, "settings.json"), join(cwd, ".foxy-harness", "settings.json")]) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    try {
      const { hooks } = (await file.json()) as { hooks?: HookConfig };
      for (const [event, matchers] of Object.entries(hooks ?? {}) as [EventType, Matcher[]][]) {
        config[event] = [...(config[event] ?? []), ...matchers];
      }
    } catch (err) {
      console.error(`foxy-harness: skipping hooks in ${path} (${err})`);
    }
  }
  return config;
}

export function registerCommandHooks(hooks: Hooks, config: HookConfig, sessionId: string, cwd: string) {
  for (const [event, matchers] of Object.entries(config) as [EventType, Matcher[]][]) {
    hooks.on(event, async (e: HarnessEvent) => {
      const commands = matchers
        .filter((m) => matches(m.matcher, matchTarget(e)))
        .flatMap((m) => m.hooks.filter((h) => h.type === "command"));
      if (!commands.length) return;
      const payload = JSON.stringify({
        session_id: sessionId,
        transcript_path: sessionPath(sessionId),
        cwd,
        hook_event_name: event,
        ...fields(e),
      });
      const results = await Promise.all(commands.map((h) => run(h, payload, cwd)));
      return combine(event, results);
    });
  }
}

// What a matcher is tested against, as in Claude Code. Events without one run every hook.
function matchTarget(e: HarnessEvent): string | undefined {
  if (e.type === "PreToolUse" || e.type === "PostToolUse") return e.tool;
  if (e.type === "SessionStart") return e.source;
  if (e.type === "PreCompact") return e.trigger;
  if (e.type === "Notification") return e.notificationType;
}

function matches(matcher: string | undefined, target: string | undefined): boolean {
  if (!matcher || matcher === "*" || target === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`, "i").test(target);
  } catch {
    return matcher === target;
  }
}

// The event in Claude Code's field names.
function fields(e: HarnessEvent): Record<string, unknown> {
  switch (e.type) {
    case "SessionStart":
      return { source: e.source };
    case "UserPromptSubmit":
      return { prompt: e.prompt };
    case "PreToolUse":
      return { tool_name: e.tool, tool_input: e.input, tool_use_id: e.callId };
    case "PostToolUse":
      return { tool_name: e.tool, tool_input: e.input, tool_response: { output: e.output, success: e.ok } };
    case "PreCompact":
      return { trigger: e.trigger, custom_instructions: "" };
    case "Notification":
      return { message: e.message, notification_type: e.notificationType };
    case "Stop":
      return { stop_hook_active: false, reason: e.reason };
    case "SessionEnd":
      return { reason: "other" };
  }
}

type RunResult = { code: number; stdout: string; stderr: string };

async function run(hook: CommandHook, payload: string, cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(["sh", "-c", hook.command], {
    cwd,
    stdin: new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FOXY_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd },
  });
  const timer = setTimeout(() => proc.kill(), (hook.timeout ?? 60) * 1000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function combine(event: EventType, results: RunResult[]): HookResult {
  const context: string[] = [];
  for (const r of results) {
    if (r.code === 2) {
      if (BLOCKABLE.has(event)) return { block: r.stderr || "blocked by hook" };
      if (event === "PostToolUse" && r.stderr) context.push(r.stderr);
      continue;
    }
    if (r.code !== 0) {
      console.error(`\x1b[2m${event} hook failed (exit ${r.code})${r.stderr ? `: ${r.stderr}` : ""}\x1b[0m`);
      continue;
    }
    const out = parse(r.stdout);
    if (!out) {
      // Plain stdout is context for the prompt, as in Claude Code.
      if (event === "UserPromptSubmit" && r.stdout) context.push(r.stdout);
      continue;
    }
    const specific = out.hookSpecificOutput ?? {};
    const reason = out.reason ?? specific.permissionDecisionReason ?? "blocked by hook";
    if (BLOCKABLE.has(event) && (out.decision === "block" || specific.permissionDecision === "deny")) return { block: reason };
    // A blocked PostToolUse can't undo the tool, so its reason goes to the model instead.
    if (event === "PostToolUse" && out.decision === "block") context.push(reason);
    if (specific.additionalContext) context.push(specific.additionalContext);
  }
  return context.length ? { context: context.join("\n\n") } : undefined;
}

type HookOutput = {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
};

function parse(stdout: string): HookOutput | undefined {
  if (!stdout.startsWith("{")) return;
  try {
    return JSON.parse(stdout) as HookOutput;
  } catch {
    return;
  }
}
