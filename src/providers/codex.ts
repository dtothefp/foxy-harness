import { getAuth, ORIGINATOR } from "../auth/codex-oauth.ts";
import { webSearchTool } from "../tools/web.ts";
import { sseEvents } from "./sse.ts";
import { type Completion, type CompletionRequest, type Attachment, type Message, type Provider, reasoningHeading, type ServerToolCall, SUMMARY_PREFIX, type ToolCall } from "./types.ts";

// ChatGPT-subscription Codex backend (Responses API over SSE). See docs/codex-backend.md.
const BASE = "https://chatgpt.com/backend-api/codex";
const CONTEXT_WINDOW = 272_000;

// effort is HARNESS_EFFORT (minimal, low, medium, high, xhigh). Codex CLI's default is medium.
export function codexProvider(model: string, sessionId: string, effort = "medium"): Provider {
  async function request(req: CompletionRequest, extra: unknown[] = []) {
    let res = await send(req, model, sessionId, effort, false, extra);
    if (res.status === 401) res = await send(req, model, sessionId, effort, true, extra);
    if (!res.ok) throw new Error(`codex ${res.status}: ${await res.text()}`);
    return readStream(res, req);
  }
  return {
    name: "codex",
    model,
    contextWindow: CONTEXT_WINDOW,
    settings: { effort, reasoning: "summary auto" },
    // The Responses API's hosted search. It can also open pages and search within them.
    hostedTools: [{ name: "web_search", hint: webSearchTool.hint }],
    complete: (req) => request(req),
    // Remote compaction, what Codex CLI does. A compaction_trigger item at the end of the input makes the
    // server answer with one encrypted "compaction" item, which stands in for the history from then on.
    async compact(req) {
      const res = await request(req, [{ type: "compaction_trigger" }]);
      const item = res.raw.find((i) => (i as { type?: string }).type === "compaction");
      return item ? { role: "summary", text: "", raw: item } : undefined;
    },
  };
}

async function send(req: CompletionRequest, model: string, sessionId: string, effort: string, forceRefresh: boolean, extra: unknown[]) {
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
      input: [...toInput(req.messages), ...extra],
      tools: [...req.tools.map((t) => ({ type: "function", ...t })), { type: "web_search" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort, summary: "auto" },
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
      store: false,
      stream: true,
      prompt_cache_key: sessionId,
    }),
  });
}

function toInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];
  // Function call outputs are text only. Images from a batch of tool results follow as one user message,
  // the way Codex CLI's view_image does it.
  let pending: Attachment[] = [];
  const flush = () => {
    if (pending.length) input.push({ type: "message", role: "user", content: pending.map(inputAttachment) });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== "tool") flush();
    if (m.role === "user") {
      input.push({ type: "message", role: "user", content: [...(m.attachments ?? []).map(inputAttachment), { type: "input_text", text: m.text }] });
    } else if (m.role === "summary") {
      if (m.raw) input.push(stripId(m.raw));
      else input.push({ type: "message", role: "user", content: [{ type: "input_text", text: SUMMARY_PREFIX + m.text }] });
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.callId, output: m.output });
      pending.push(...(m.attachments ?? []));
    } else if (m.raw) {
      // With store:false the server keeps nothing, so item ids can't be referenced. Strip them.
      for (const item of m.raw) input.push(stripId(item));
    } else if (m.text) {
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
    }
  }
  flush();
  return input;
}

function inputAttachment(a: Attachment) {
  const url = `data:${a.mediaType};base64,${a.data}`;
  return a.mediaType === "application/pdf" ? { type: "input_file", filename: a.name, file_data: url } : { type: "input_image", image_url: url };
}

function stripId(item: unknown) {
  const { id: _id, ...rest } = item as Record<string, unknown>;
  return rest;
}

async function readStream(res: Response, { onText, onReasoning, onServerTool }: CompletionRequest): Promise<Completion> {
  const started = performance.now();
  const out: Completion = { text: "", toolCalls: [], raw: [], usage: {} };

  for await (const ev of sseEvents(res)) {
    switch (ev.type) {
      case "response.output_text.delta":
        out.firstTokenMs ??= performance.now() - started;
        out.text += ev.delta;
        onText?.(ev.delta);
        break;
      case "response.reasoning_summary_text.done": {
        const line = reasoningHeading(String(ev.text ?? ""));
        if (line) onReasoning?.(line);
        break;
      }
      case "response.output_item.done": {
        out.firstTokenMs ??= performance.now() - started;
        out.raw.push(ev.item);
        if (ev.item.type === "function_call") out.toolCalls.push(parseCall(ev.item));
        if (ev.item.type === "web_search_call") onServerTool?.(searchCall(ev.item));
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
            thinkingTokens: u.output_tokens_details?.reasoning_tokens,
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

// action is { type: "search", query, sources } or { type: "open_page" | "find_in_page", url, pattern }.
function searchCall(item: { id: string; status?: string; action?: Record<string, any> }): ServerToolCall {
  const { type, query, url, pattern, sources } = item.action ?? {};
  const input = type === "search" ? { query } : { url, ...(pattern ? { pattern } : {}) };
  const urls = ((sources ?? []) as { url?: string }[]).flatMap((s) => (s.url ? [s.url] : []));
  const output = urls.length ? urls.join("\n") : type === "search" ? "No sources listed." : `Opened ${url ?? "page"}`;
  return { id: item.id, name: "web_search", input, output, ok: item.status !== "failed" };
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
  const res = await fetch(`${BASE}/models?client_version=0.200.0`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      originator: ORIGINATOR,
    },
  });
  if (!res.ok) throw new Error(`models ${res.status}: ${await res.text()}`);
  return res.json();
}
