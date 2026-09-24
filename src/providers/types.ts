// Provider-neutral conversation. Each provider translates to its own wire format.
// `raw` holds the provider's native output items so they can be replayed verbatim
// (Codex needs its encrypted reasoning items echoed back on the next turn).

export type ToolCall = { id: string; name: string; input: unknown };

// A base64 image or PDF, attached to a prompt (dragged in) or a tool result (read_file). `pages` is set for PDFs.
export type Attachment = { name: string; mediaType: string; data: string; pages?: number };

export type Message =
  | { role: "user"; text: string; attachments?: Attachment[] }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown[]; usage?: Usage }
  // `context` is what a PostToolUse hook appended to `output` (package instructions). It survives clearing.
  | { role: "tool"; callId: string; output: string; context?: string; attachments?: Attachment[] }
  // Stands in for every message before it after compaction. `raw` is the provider's native
  // compaction item (Codex's encrypted item, Claude's signed block). Without it, `text` is our own summary.
  | { role: "summary"; text: string; raw?: unknown };

export type ToolSpec = { name: string; description: string; parameters: object };

// thinkingTokens is the part of outputTokens spent reasoning, where the backend reports it.
export type Usage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; thinkingTokens?: number };

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
  // What the request asks for, e.g. { effort: "high", thinking: "adaptive, summarized" }. Saved with the session.
  settings: Record<string, string>;
  complete(req: CompletionRequest): Promise<Completion>;
  // Server-side compaction, where the backend has it. Returns undefined when it isn't available,
  // and the agent falls back to its own summary (src/compact.ts).
  compact?(req: CompletionRequest): Promise<Message | undefined>;
}

export const SUMMARY_PREFIX = "Summary of the conversation so far (earlier messages were compacted):\n\n";

// Reasoning summaries run a few paragraphs. Show one line, the bold heading if there is one
// ("Inspecting test setup"), else the first sentence, cut at a word boundary.
export function reasoningHeading(text: string, max = 110): string | undefined {
  const heading = text.match(/^\s*\*\*(.+?)\*\*/)?.[1];
  const first = text.trim().split("\n")[0]!;
  let line = (heading ?? first.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? first).trim();
  if (line.length > max) line = `${line.slice(0, line.lastIndexOf(" ", max - 1) > max / 2 ? line.lastIndexOf(" ", max - 1) : max - 1)}…`;
  return line || undefined;
}
