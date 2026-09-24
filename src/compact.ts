import type { CompletionRequest, Message, Provider } from "./providers/types.ts";

// Context management, two stages, checked before each model call:
//   1. Past CLEAR_AT of the window, old tool results are swapped for a stub. Cheap, no model call.
//      Tool output is most of what grows a coding session, and the model can rerun a tool.
//   2. Past COMPACT_AT, the history is replaced by a summary. The provider's server-side compaction
//      when it has one (Codex, Claude API), else a summary we ask the model for (Bedrock).

export const CLEAR_AT = 0.6;
export const COMPACT_AT = 0.85;
const KEEP_RECENT = 3; // tool results left untouched
const MIN_CHARS = 500; // not worth clearing below this

export const CLEARED = "[Output cleared to save context. Run the tool again if you need it.]";

// Rough token count for text we haven't sent yet. Real usage replaces it after the next call.
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

// Returns the number of characters removed.
export function clearToolResults(messages: Message[]): number {
  const tools = messages.filter((m) => m.role === "tool");
  let freed = 0;
  for (const m of tools.slice(0, -KEEP_RECENT)) {
    if (m.output.length < MIN_CHARS || m.output.startsWith(CLEARED)) continue;
    const next = m.context ? `${CLEARED}\n\n${m.context}` : CLEARED;
    freed += m.output.length - next.length;
    m.output = next;
  }
  return freed;
}

const SUMMARY_PROMPT = `Your context window is filling up, so this conversation is about to be replaced by a summary you write now. Don't call any tools. Reply with the summary only.

Write it for yourself, picking the work back up with no other memory of this conversation. Include:
- Everything the user asked for or told you, in their words where it matters: requests, constraints, preferences, and any specific values, names or facts they gave, even ones that seem incidental.
- What's done: files changed and how, commands run and what they showed.
- Key facts learned about the codebase (paths, function names, how things fit together).
- Errors hit and how they were resolved, or that they're still open.
- What's left, and the exact next step.
The five-line limit on final answers doesn't apply here. Be thorough (a few hundred words is normal), specific and dense. Prefer paths and names over prose.`;

// Fallback when the provider has no server-side compaction. Same system prompt and tools,
// so the request reuses the prompt cache.
export async function summarize(provider: Provider, req: CompletionRequest): Promise<Message> {
  const res = await provider.complete({
    ...req,
    messages: [...req.messages, { role: "user", text: SUMMARY_PROMPT }],
    onText: undefined,
    onReasoning: undefined,
  });
  const text = res.text.trim();
  if (!text) throw new Error("Compaction failed: the model returned no summary.");
  return { role: "summary", text };
}
