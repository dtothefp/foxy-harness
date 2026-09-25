import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import { attachmentChars } from "./attachments.ts";
import { CLEAR_AT, CLEAR_MIN, clearToolResults, COMPACT_AT, estimateTokens, summarize } from "./compact.ts";
import { formatSkills, type Instructions, type Skill } from "./context.ts";
import type { Hooks } from "./events.ts";
import type { CompletionRequest, Attachment, Message, Provider, ToolSpec } from "./providers/types.ts";
import { applyChanges } from "./tools/changes.ts";
import type { FileChange, Tool, ToolResult } from "./tools/types.ts";

// The whole agent: call the model, run any tool calls, feed results back, repeat
// until the model answers without calling a tool. Trajectory is saved every step.

export type AgentOptions = {
  provider: Provider;
  hooks: Hooks;
  cwd: string;
  sessionId: string;
  system: string;
  tools: Tool[];
  // Model calls per turn before the turn stops. Unlimited by default, like Claude Code. Ctrl+C stops a turn.
  maxSteps?: number;
  // Tokens the model can take. Defaults to the provider's. Compaction thresholds are fractions of it.
  contextWindow?: number;
  // Advertised to the model but with no implementation. Used to demo the unknown-tool path.
  fakeTools?: ToolSpec[];
  onText?: (delta: string) => void;
  onReasoning?: (summary: string) => void;
  // callId is the model's id for the call, the same one PreToolUse carries.
  onToolStart?: (name: string, input: unknown, changes: FileChange[] | undefined, callId: string) => void;
  onToolEnd?: (output: string, ok: boolean, changes: FileChange[] | undefined, name: string, input: unknown, callId: string) => void;
  onStep?: (info: { ms: number; firstTokenMs?: number; usage: object }) => void;
  onCompact?: (info: CompactInfo) => void;
  // A message sent mid-run just went to the model.
  onSteer?: (text: string) => void;
};

export type CompactInfo =
  | { kind: "clear"; freedTokens: number }
  | { kind: "start"; trigger: "auto" | "manual" }
  | { kind: "failed"; error: string }
  | { kind: "summary"; trigger: "auto" | "manual"; before: number; after: number; native: boolean };

export class Agent {
  messages: Message[] = [];
  // Size of the next request: the last call's input + output, plus estimates for anything added since.
  contextTokens = 0;
  // Messages sent while a run is going. They go to the model at the next step of that run.
  private queued: { text: string; attachments?: Attachment[] }[] = [];
  constructor(private opts: AgentOptions) {}

  // Adds a message to the running turn, the way typing mid-run works in Claude Code. It goes in after the
  // current step's tool results, so the model sees it before deciding what to do next.
  steer(text: string, attachments?: Attachment[]) {
    this.queued.push({ text, attachments });
  }

  // Queued messages the model never saw (the run stopped first), so the frontend can hand them back.
  takeQueued() {
    const queued = this.queued;
    this.queued = [];
    return queued;
  }

  get provider() {
    return this.opts.provider;
  }
  // /model swaps it between turns. Same provider family only, since the history holds its raw items.
  set provider(p: Provider) {
    this.opts.provider = p;
  }

  // Picks up a saved history. The context size is the last call's usage plus estimates for what came after.
  restore(messages: Message[]) {
    this.messages = messages;
    const last = messages.findLastIndex((m) => m.role === "assistant" && m.usage?.inputTokens != null);
    const usage = last >= 0 && messages[last]!.role === "assistant" ? messages[last]!.usage : undefined;
    const base = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : estimateTokens(this.opts.system.length);
    this.contextTokens = base + messages.slice(last + 1).reduce((n, m) => n + estimateTokens(messageChars(m)), 0);
  }

  get contextWindow() {
    return this.opts.contextWindow ?? this.opts.provider.contextWindow;
  }

  async run(prompt: string, signal?: AbortSignal, attachments?: Attachment[]): Promise<void> {
    const { hooks, provider } = this.opts;
    const first = await this.userMessage(prompt, attachments);

    const maxSteps = this.opts.maxSteps ?? Infinity;
    try {
      // Before the prompt goes in, so a compaction here never swallows it.
      await this.manageContext(signal);
      this.push(first, first.text.length + charsOf(attachments));

      for (let step = 0; step < maxSteps; step++) {
        // Mid-task compaction leaves only the summary. Tell the model to carry on from it.
        if (step > 0 && (await this.manageContext(signal))) {
          this.push({ role: "user", text: "Continue the task from the summary." }, 40);
        }
        if (step > 0) await this.sendQueued();
        const started = performance.now();
        const res = await provider.complete({
          ...this.request(signal),
          onText: this.opts.onText,
          onReasoning: this.opts.onReasoning,
          // Already done by the time it's reported, so no hooks or permission, just the frontends.
          onServerTool: (c) => {
            this.opts.onToolStart?.(c.name, c.input, undefined, c.id);
            this.opts.onToolEnd?.(c.output, c.ok, undefined, c.name, c.input, c.id);
          },
        });
        this.opts.onStep?.({ ms: performance.now() - started, firstTokenMs: res.firstTokenMs, usage: res.usage });
        this.messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw, usage: res.usage });
        if (res.usage.inputTokens != null) this.contextTokens = res.usage.inputTokens + (res.usage.outputTokens ?? 0);

        if (res.toolCalls.length === 0) {
          // A message sent after the model's last tool call keeps the run going instead of waiting for a new one.
          if (this.queued.length) continue;
          await this.save();
          await hooks.emit({ type: "Stop", reason: "end_turn" });
          return;
        }

        for (const call of res.toolCalls) {
          const { output, context, attachments } = await this.runTool(call.id, call.name, call.input, signal);
          this.push({ role: "tool", callId: call.id, output, context, attachments }, output.length + charsOf(attachments));
        }
        await this.save();
      }
      await hooks.emit({ type: "Stop", reason: "max_steps" });
    } catch (err) {
      await this.save();
      const reason = signal?.aborted ? "interrupted" : "error";
      await hooks.emit({ type: "Stop", reason, error: String(err) });
      if (reason === "error") throw err;
    }
  }

  // Replaces the whole history with a summary. Called automatically near the window limit, or by /compact.
  async compact(trigger: "auto" | "manual", signal?: AbortSignal): Promise<boolean> {
    if (!this.messages.length) return false;
    const pre = await this.opts.hooks.emit({ type: "PreCompact", trigger });
    if (pre.block) return false;

    const req = this.request(signal);
    this.opts.onCompact?.({ kind: "start", trigger });
    let native: Message | undefined;
    let summary: Message;
    try {
      native = await this.opts.provider.compact?.(req).catch((err) => {
        if (signal?.aborted) throw err;
        return undefined; // server-side compaction unavailable, summarize ourselves
      });
      summary = native ?? (await summarize(this.opts.provider, req));
    } catch (err) {
      this.opts.onCompact?.({ kind: "failed", error: errorText(err) });
      throw err;
    }

    const before = this.contextTokens;
    this.messages = [summary];
    this.contextTokens = estimateTokens(this.opts.system.length + JSON.stringify(summary).length);
    this.opts.onCompact?.({ kind: "summary", trigger, before, after: this.contextTokens, native: !!native });
    await this.save();
    return true;
  }

  // Clear old tool results past CLEAR_AT, summarize past COMPACT_AT. Returns true if it summarized.
  private async manageContext(signal?: AbortSignal): Promise<boolean> {
    const window = this.contextWindow;
    if (this.contextTokens > window * CLEAR_AT) {
      // A small clear costs a cache break for little room, so it waits until there is a big batch to clear.
      const freed = estimateTokens(clearToolResults(this.messages, window * CLEAR_MIN * 4));
      if (freed > 0) {
        this.contextTokens -= freed;
        this.opts.onCompact?.({ kind: "clear", freedTokens: freed });
      }
    }
    return this.contextTokens > window * COMPACT_AT && this.compact("auto", signal);
  }

  private request(signal?: AbortSignal): CompletionRequest {
    return {
      system: this.opts.system,
      messages: this.messages,
      tools: [...this.opts.tools.map((t) => t.spec), ...(this.opts.fakeTools ?? [])],
      signal,
    };
  }

  // The user message for a prompt, after UserPromptSubmit hooks had their say.
  private async userMessage(prompt: string, attachments?: Attachment[]): Promise<Message & { role: "user" }> {
    const submitted = await this.opts.hooks.emit({ type: "UserPromptSubmit", prompt });
    if (submitted.block) throw new Error(`Prompt blocked: ${submitted.block}`);
    const text = submitted.context ? `${prompt}\n\n${submitted.context}` : prompt;
    return attachments?.length ? { role: "user", text, attachments } : { role: "user", text };
  }

  private async sendQueued() {
    for (const { text, attachments } of this.takeQueued()) {
      const message = await this.userMessage(text, attachments);
      this.push(message, message.text.length + charsOf(attachments));
      this.opts.onSteer?.(text);
    }
  }

  private push(message: Message, chars: number) {
    this.messages.push(message);
    this.contextTokens += estimateTokens(chars);
  }

  private async runTool(
    callId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ output: string; context?: string; attachments?: Attachment[] }> {
    const { hooks, cwd } = this.opts;
    const args = input as Record<string, unknown>;
    const ctx = { cwd, signal };
    const tool = this.opts.tools.find((t) => t.spec.name === name);
    if (!tool) return this.finish(callId, name, input, { output: `Unknown tool: ${name}`, ok: false });

    // Edit tools plan first, so hooks and the UI can show the diff before anything is written.
    let changes: FileChange[] | undefined;
    if ("plan" in tool) {
      try {
        changes = await tool.plan(args, ctx);
      } catch (err) {
        return this.finish(callId, name, input, { output: errorText(err), ok: false });
      }
    }

    const denied = await hooks.emit({ type: "PreToolUse", tool: name, input, callId, changes });
    if (denied.block) return { output: `Tool call denied: ${denied.block}` };

    this.opts.onToolStart?.(name, input, changes, callId);
    let result: ToolResult;
    try {
      result = "plan" in tool ? { output: await applyChanges(changes!, cwd), ok: true } : await tool.run(args, ctx);
    } catch (err) {
      result = { output: errorText(err), ok: false };
    }
    return this.finish(callId, name, input, result, changes, true);
  }

  private async finish(callId: string, name: string, input: unknown, r: ToolResult, changes?: FileChange[], started = false) {
    if (!started) this.opts.onToolStart?.(name, input, undefined, callId);
    this.opts.onToolEnd?.(r.output, r.ok, changes, name, input, callId);
    const post = await this.opts.hooks.emit({ type: "PostToolUse", tool: name, input, output: r.output, ok: r.ok, changes });
    // Context is kept separately too, so clearing an old result doesn't drop package instructions.
    const attachments = r.attachments?.length ? r.attachments : undefined;
    return post.context
      ? { output: `${r.output}\n\n${post.context}`, context: post.context, attachments }
      : { output: r.output, attachments };
  }

  // What's saved to the session file, and what /session summarizes.
  snapshot() {
    const { provider, cwd } = this.opts;
    return { provider: provider.name, model: provider.model, settings: provider.settings, cwd, messages: this.messages };
  }

  private async save() {
    const dir = join(HARNESS_HOME, "sessions");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${this.opts.sessionId}.json`), JSON.stringify(this.snapshot(), null, 2));
  }
}

// `hosted` are tools the backend runs (web search), listed alongside the harness's own.
export function buildSystemPrompt(
  cwd: string,
  tools: Tool[],
  instructions?: Instructions,
  skills: Skill[] = [],
  hosted: { name: string; hint: string }[] = [],
): string {
  const listed = [...tools.map((t) => ({ name: t.spec.name, hint: t.hint })), ...hosted];
  let prompt = `You are foxy-harness, a coding agent running in the user's terminal.
Working directory: ${cwd}
Platform: ${process.platform}

Tools:
${listed.map((t) => `- ${t.name}: ${t.hint}`).join("\n")}

Guidelines:
- Explore before editing. Prefer rg and fd if installed.
- Read a file before editing it. Make small targeted edits, never rewrite a whole file to change a few lines.
- Run the project's tests or typecheck after changes when they exist.
- To set up or repair Agent of Empires (aoe) and tmux for foxy-harness, run \`foxy-harness aoe live\` (open sessions inside aoe) or \`foxy-harness aoe tmux\` (attach to tmux). \`foxy-harness aoe --check\` only reports.
- To read an earlier foxy-harness session (to pick up its work), run \`foxy-harness transcript --list\`, then \`foxy-harness transcript <id>\`.

Communication:
- The user watches you work in a terminal. Before each group of tool calls, write one short line (under 15 words) on what you're doing and why, e.g. "Checking how config is loaded before adding the flag." Skip it for obvious follow-ups.
- Don't narrate individual commands, restate tool output, or say what you're about to say.
- When the task is done, reply without a tool call in at most 5 short lines: what changed or what you found, how you verified it, and anything the user must do. No headers, no step-by-step recap, no closing offers.
- Go longer only when the user asks for an explanation or detail.`;

  if (skills.length) {
    prompt += `\n\n# Skills
When a task matches a skill, read its SKILL.md with read_file first and follow it. Paths inside a skill are relative to its folder.
${formatSkills(skills)}`;
  }
  if (instructions) prompt += `\n\n# Instructions (${instructions.path})\n${instructions.text}`;
  return prompt;
}

const charsOf = (a: Attachment[] = []) => a.reduce((n, x) => n + attachmentChars(x), 0);
// Attachments count by what the model sees, not by their base64 size.
const messageChars = (m: Message) =>
  "attachments" in m && m.attachments
    ? JSON.stringify({ ...m, attachments: undefined }).length + charsOf(m.attachments)
    : JSON.stringify(m).length;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
