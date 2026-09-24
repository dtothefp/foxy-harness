import { getAuth, ORIGINATOR } from "../auth/codex-oauth.ts";
import { sseEvents } from "./sse.ts";
import type { Completion, CompletionRequest, Message, Provider, ToolCall } from "./types.ts";

// ChatGPT-subscription Codex backend (Responses API over SSE). See docs/codex-backend.md.
const BASE = "https://chatgpt.com/backend-api/codex";

export function codexProvider(model: string, sessionId: string): Provider {
  return {
    name: "codex",
    model,
    async complete(req) {
      let res = await send(req, model, sessionId, false);
      if (res.status === 401) res = await send(req, model, sessionId, true);
      if (!res.ok) throw new Error(`codex ${res.status}: ${await res.text()}`);
      return readStream(res, req.onText, req.onReasoning);
    },
  };
}

async function send(req: CompletionRequest, model: string, sessionId: string, forceRefresh: boolean) {
  const auth = await getAuth({ forceRefresh });
  return fetch(`${BASE}/responses`, {
    method: "POST",
    signal: req.signal,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: ORIGINATOR,
      "session-id": sessionId,
      "x-client-request-id": crypto.randomUUID(),
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: req.system,
      input: toInput(req.messages),
      tools: req.tools.map((t) => ({ type: "function", ...t })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "medium", summary: "auto" },
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
      prompt_cache_key: sessionId,
    }),
  });
}

function toInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.text }] });
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.callId, output: m.output });
    } else if (m.raw) {
      // With store:false the server keeps nothing, so item ids can't be referenced. Strip them.
      for (const item of m.raw) {
        const { id: _id, ...rest } = item as Record<string, unknown>;
        input.push(rest);
      }
    } else if (m.text) {
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
    }
  }
  return input;
}

async function readStream(
  res: Response,
  onText?: (d: string) => void,
  onReasoning?: (s: string) => void,
): Promise<Completion> {
  const started = performance.now();
  const out: Completion = { text: "", toolCalls: [], raw: [], usage: {} };

  for await (const ev of sseEvents(res)) {
    switch (ev.type) {
      case "response.output_text.delta":
        out.firstTokenMs ??= performance.now() - started;
        out.text += ev.delta;
        onText?.(ev.delta);
        break;
      // Reasoning summaries are a few paragraphs per step. Show only the heading, e.g. "Inspecting test setup".
      case "response.reasoning_summary_text.done": {
        const line = String(ev.text ?? "").match(/^\s*\*\*(.+?)\*\*/)?.[1] ?? String(ev.text ?? "").split("\n")[0]!;
        if (line.trim()) onReasoning?.(line.trim().slice(0, 100));
        break;
      }
      case "response.output_item.done": {
        out.firstTokenMs ??= performance.now() - started;
        out.raw.push(ev.item);
        if (ev.item.type === "function_call") out.toolCalls.push(parseCall(ev.item));
        break;
      }
      case "response.completed":
      case "response.done":
      case "response.incomplete": {
        const u = ev.response?.usage;
        if (u) {
          out.usage = {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cachedTokens: u.input_tokens_details?.cached_tokens,
          };
        }
        break;
      }
      case "error":
      case "response.failed":
        throw new Error(`codex stream error: ${JSON.stringify(ev.error ?? ev.response?.error ?? ev)}`);
    }
  }
  return out;
}

function parseCall(item: { call_id: string; name: string; arguments: string }): ToolCall {
  let input: unknown;
  try {
    input = JSON.parse(item.arguments || "{}");
  } catch {
    input = { __parse_error: item.arguments };
  }
  return { id: item.call_id, name: item.name, input };
}

export async function listModels(): Promise<unknown> {
  const auth = await getAuth();
  const res = await fetch(`${BASE}/models?client_version=0.1.0`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      originator: ORIGINATOR,
    },
  });
  if (!res.ok) throw new Error(`models ${res.status}: ${await res.text()}`);
  return res.json();
}
