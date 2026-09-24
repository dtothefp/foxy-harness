// Provider-neutral conversation. Each provider translates to its own wire format.
// `raw` holds the provider's native output items so they can be replayed verbatim
// (Codex needs its encrypted reasoning items echoed back on the next turn).

export type ToolCall = { id: string; name: string; input: unknown };

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown[] }
  | { role: "tool"; callId: string; output: string };

export type ToolSpec = { name: string; description: string; parameters: object };

export type Usage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number };

export type CompletionRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
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
  complete(req: CompletionRequest): Promise<Completion>;
}
