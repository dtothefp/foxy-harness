import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import type { Hooks } from "./events.ts";
import type { Message, Provider, ToolSpec } from "./providers/types.ts";
import { TOOLS } from "./tools/index.ts";

// The whole agent: call the model, run any tool calls, feed results back, repeat
// until the model answers without calling a tool. Trajectory is saved every step.

export type AgentOptions = {
  provider: Provider;
  hooks: Hooks;
  cwd: string;
  sessionId: string;
  system: string;
  maxSteps?: number;
  // Advertised to the model but with no implementation. Used to demo the unknown-tool path.
  fakeTools?: ToolSpec[];
  onText?: (delta: string) => void;
  onToolStart?: (name: string, input: unknown) => void;
  onToolEnd?: (output: string, ok: boolean) => void;
  onStep?: (info: { ms: number; firstTokenMs?: number; usage: object }) => void;
};

export class Agent {
  messages: Message[] = [];
  constructor(private opts: AgentOptions) {}

  async run(prompt: string, signal?: AbortSignal): Promise<void> {
    const { hooks, provider } = this.opts;
    const blocked = await hooks.emit({ type: "UserPromptSubmit", prompt });
    if (blocked) throw new Error(`Prompt blocked: ${blocked.block}`);
    this.messages.push({ role: "user", text: prompt });

    const maxSteps = this.opts.maxSteps ?? 50;
    try {
      for (let step = 0; step < maxSteps; step++) {
        const started = performance.now();
        const res = await provider.complete({
          system: this.opts.system,
          messages: this.messages,
          tools: [...TOOLS.map((t) => t.spec), ...(this.opts.fakeTools ?? [])],
          signal,
          onText: this.opts.onText,
        });
        this.opts.onStep?.({ ms: performance.now() - started, firstTokenMs: res.firstTokenMs, usage: res.usage });
        this.messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw });

        if (res.toolCalls.length === 0) {
          await this.save();
          await hooks.emit({ type: "Stop", reason: "end_turn" });
          return;
        }

        for (const call of res.toolCalls) {
          const output = await this.runTool(call.id, call.name, call.input, signal);
          this.messages.push({ role: "tool", callId: call.id, output });
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

  private async runTool(callId: string, name: string, input: unknown, signal?: AbortSignal): Promise<string> {
    const { hooks, cwd } = this.opts;
    const denied = await hooks.emit({ type: "PreToolUse", tool: name, input, callId });
    if (denied) return `Tool call denied by user: ${denied.block}`;

    this.opts.onToolStart?.(name, input);
    const tool = TOOLS.find((t) => t.spec.name === name);
    const { output, ok } = tool
      ? await tool.run(input as Record<string, unknown>, { cwd, signal })
      : { output: `Unknown tool: ${name}`, ok: false };
    this.opts.onToolEnd?.(output, ok);
    await hooks.emit({ type: "PostToolUse", tool: name, input, output, ok });
    return output;
  }

  private async save() {
    const dir = join(HARNESS_HOME, "sessions");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, `${this.opts.sessionId}.json`),
      JSON.stringify({ model: this.opts.provider.model, cwd: this.opts.cwd, messages: this.messages }, null, 2),
    );
  }
}

export async function buildSystemPrompt(cwd: string): Promise<string> {
  let prompt = `You are fox-harness, a coding agent running in the user's terminal.
Working directory: ${cwd}
Platform: ${process.platform}

Tools:
- read_file: read files (with line numbers). Prefer it over cat/head/sed for reading.
- bash: everything else. Each call runs in a fresh shell, so cd and exported env vars do not persist; prefix commands with \`cd dir &&\` when needed.
- Explore before editing. Prefer rg and fd if installed.
- Edit files with small targeted changes (heredocs, sed, or a short python/bun script). Never rewrite a whole file just to change a few lines.
- Run the project's tests or typecheck after changes when they exist.
- Be concise. When the task is done, reply with a short summary and no tool call.`;

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const f = Bun.file(join(cwd, name));
    if (await f.exists()) {
      prompt += `\n\n# Project instructions (${name})\n${await f.text()}`;
      break;
    }
  }
  return prompt;
}
