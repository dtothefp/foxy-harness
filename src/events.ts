import type { FileChange } from "./tools/types.ts";

// Lifecycle events, named after the Claude Code hooks model:
// SessionStart → UserPromptSubmit → [PreToolUse → tool → PostToolUse]* → Stop → SessionEnd
// Handlers are in-process functions. Nothing runs unless something is registered.

export type HarnessEvent =
  | { type: "SessionStart"; sessionId: string; cwd: string }
  | { type: "UserPromptSubmit"; prompt: string }
  // `changes` is set for edit tools: the planned file writes, so a hook can show the diff before approving.
  | { type: "PreToolUse"; tool: string; input: unknown; callId: string; changes?: FileChange[] }
  | { type: "PostToolUse"; tool: string; input: unknown; output: string; ok: boolean }
  | { type: "Stop"; reason: "end_turn" | "max_steps" | "interrupted" | "error"; error?: string }
  | { type: "SessionEnd"; sessionId: string };

export type EventType = HarnessEvent["type"];
type EventOf<T extends EventType> = Extract<HarnessEvent, { type: T }>;

// A handler may block the action (only meaningful for UserPromptSubmit and PreToolUse).
export type HookResult = void | { block: string };
type Handler<T extends EventType> = (event: EventOf<T>) => HookResult | Promise<HookResult>;

export class Hooks {
  private handlers = new Map<EventType, Handler<any>[]>();

  on<T extends EventType>(type: T, handler: Handler<T>) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  // Runs handlers in order. The first { block } wins and is returned.
  async emit<T extends EventType>(event: EventOf<T>): Promise<{ block: string } | undefined> {
    for (const handler of this.handlers.get(event.type) ?? []) {
      const result = await handler(event);
      if (result && "block" in result) return result;
    }
  }
}
