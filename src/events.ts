import type { FileChange } from "./tools/types.ts";

// Lifecycle events, named after the Claude Code hooks model:
// SessionStart → UserPromptSubmit → [PreToolUse → tool → PostToolUse]* → Stop → SessionEnd
// PreCompact fires before a summary replaces the history (auto or /compact). Returning { block } skips it.
// Handlers are in-process functions. Nothing runs unless something is registered.

export type HarnessEvent =
  | { type: "SessionStart"; sessionId: string; cwd: string; source: "startup" | "resume" }
  | { type: "UserPromptSubmit"; prompt: string }
  // `changes` is set for edit tools: the planned file writes, so a hook can show the diff before approving.
  | { type: "PreToolUse"; tool: string; input: unknown; callId: string; changes?: FileChange[] }
  | { type: "PostToolUse"; tool: string; input: unknown; output: string; ok: boolean; changes?: FileChange[] }
  | { type: "PreCompact"; trigger: "auto" | "manual" }
  | { type: "Stop"; reason: "end_turn" | "max_steps" | "interrupted" | "error"; error?: string }
  | { type: "SessionEnd"; sessionId: string };

export type EventType = HarnessEvent["type"];
type EventOf<T extends EventType> = Extract<HarnessEvent, { type: T }>;

// A handler may block the action (UserPromptSubmit, PreToolUse, PreCompact), or add context the model sees
// after the prompt or tool result (UserPromptSubmit, PostToolUse), like Claude Code's additionalContext.
export type HookResult = void | { block: string } | { context: string };
export type HookOutcome = { block?: string; context?: string };
type Handler<T extends EventType> = (event: EventOf<T>) => HookResult | Promise<HookResult>;

export class Hooks {
  private handlers = new Map<EventType, Handler<any>[]>();

  on<T extends EventType>(type: T, handler: Handler<T>) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  // Runs handlers in order. The first { block } wins. Context from every handler is joined.
  async emit<T extends EventType>(event: EventOf<T>): Promise<HookOutcome> {
    const context: string[] = [];
    for (const handler of this.handlers.get(event.type) ?? []) {
      const result = await handler(event);
      if (result && "block" in result) return { block: result.block };
      if (result && "context" in result) context.push(result.context);
    }
    return context.length ? { context: context.join("\n\n") } : {};
  }
}
