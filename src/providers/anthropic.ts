import { sseEvents } from "./sse.ts";
import type { Completion, CompletionRequest, Message, Provider } from "./types.ts";

// Claude via the Anthropic Messages API over SSE, with an API key.
// Claude subscription login isn't allowed in third-party tools, so there's no OAuth here.

const BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MAX_TOKENS = 32_000;
const RETRIES = 3;

export const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

type Block = Record<string, any>;

export function anthropicProvider(model: string): Provider {
  return {
    name: "anthropic",
    model,
    async complete(req) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("Set ANTHROPIC_API_KEY to use Claude models.");
      for (let attempt = 0; ; attempt++) {
        const res = await send(req, model, key);
        if (res.ok) return readStream(res, req.onText);
        // 429 rate limited, 529 overloaded, other 5xx: back off and retry.
        if (attempt < RETRIES && (res.status === 429 || res.status >= 500)) {
          const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
          await Bun.sleep(Math.min(wait, 20_000));
          continue;
        }
        throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      }
    },
  };
}

function send(req: CompletionRequest, model: string, key: string) {
  return fetch(`${BASE}/v1/messages`, {
    method: "POST",
    signal: req.signal,
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      stream: true,
      // Cache breakpoint on the system prompt. Tools render before it, so both stay cached all session.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: toMessages(req.messages),
    }),
  });
}

function toMessages(messages: Message[]) {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  // Anthropic wants strictly alternating roles, so consecutive same-role content merges.
  // That's how several tool results end up in one user message.
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.text }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.callId, content: m.output }]);
    else if (m.raw) push("assistant", m.raw as Block[]);
    else {
      push("assistant", [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
      ]);
    }
  }

  // A second, moving breakpoint on the newest block, so each step reuses the cached conversation.
  const last = out.at(-1);
  if (last) last.content[last.content.length - 1] = { ...last.content.at(-1), cache_control: { type: "ephemeral" } };
  return out;
}

async function readStream(res: Response, onText?: (d: string) => void): Promise<Completion> {
  const started = performance.now();
  const out: Completion = { text: "", toolCalls: [], raw: [], usage: {} };
  const blocks: Block[] = [];
  const json: string[] = [];

  for await (const ev of sseEvents(res)) {
    switch (ev.type) {
      case "message_start": {
        // input_tokens excludes cache hits. Report the total, like Codex does.
        const u = ev.message.usage ?? {};
        const cached = u.cache_read_input_tokens ?? 0;
        out.usage = {
          inputTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
          cachedTokens: cached,
          outputTokens: u.output_tokens,
        };
        break;
      }
      case "content_block_start":
        blocks[ev.index] = { ...ev.content_block };
        json[ev.index] = "";
        break;
      case "content_block_delta": {
        out.firstTokenMs ??= performance.now() - started;
        const b = blocks[ev.index]!;
        const d = ev.delta;
        if (d.type === "text_delta") {
          b.text = (b.text ?? "") + d.text;
          out.text += d.text;
          onText?.(d.text);
        } else if (d.type === "input_json_delta") json[ev.index] += d.partial_json;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index]!;
        if (b.type === "tool_use") {
          b.input = parseJson(json[ev.index] ?? "");
          out.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        }
        break;
      }
      case "message_delta":
        if (ev.usage?.output_tokens != null) out.usage.outputTokens = ev.usage.output_tokens;
        break;
      case "error":
        throw new Error(`anthropic stream error: ${JSON.stringify(ev.error)}`);
    }
  }
  // Replayed verbatim next turn (thinking blocks need their signatures). Empty text blocks are rejected.
  out.raw = blocks.filter((b) => b && !(b.type === "text" && !b.text));
  return out;
}

function parseJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __parse_error: s };
  }
}
