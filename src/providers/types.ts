// Provider-neutral conversation. Each provider translates to its own wire format.
// `raw` holds the provider's native output items so they can be replayed verbatim
// (Codex needs its encrypted reasoning items echoed back on the next turn).

export type ToolCall = { id: string; name: string; input: unknown };

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown[] }
  // `context` is what a PostToolUse hook appended to `output` (package instructions). It survives clearing.
  | { role: "tool"; callId: string; output: string; context?: string }
  // Stands in for every message before it after compaction. `raw` is the provider's native
  // compaction item (Codex's encrypted item, Claude's signed block). Without it, `text` is our own summary.
  | { role: "summary"; text: string; raw?: unknown };

export type ToolSpec = { name: string; description: string; parameters: object };

export type Usage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number };

export type CompletionRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  // One short line per reasoning step (a summary heading), for models that expose one.
  onReasoning?: (summary: string) => void;
};

export type Completion = {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown[];
  usage: Usage;
  firstTokenMs?: number;
};

export interface Provider {
  name: string;
  model: string;
  contextWindow: number;
  complete(req: CompletionRequest): Promise<Completion>;
  // Server-side compaction, where the backend has it. Returns undefined when it isn't available,
  // and the agent falls back to its own summary (src/compact.ts).
  compact?(req: CompletionRequest): Promise<Message | undefined>;
}

export const SUMMARY_PREFIX = "Summary of the conversation so far (earlier messages were compacted):\n\n";
