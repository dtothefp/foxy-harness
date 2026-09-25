import type { Config } from "../config.ts";
import { webSearchTool } from "../tools/web.ts";
import { eventStreamEvents } from "./eventstream.ts";
import { sseEvents } from "./sse.ts";
import {
  type Completion,
  type CompletionRequest,
  type Attachment,
  type Message,
  type Provider,
  reasoningHeading,
  SUMMARY_PREFIX,
} from "./types.ts";

// Claude over two transports that share one request and event shape:
//   anthropic  the Messages API (API key or auth token)
//   bedrock    AWS Bedrock invoke-with-response-stream, direct or through a gateway
// Claude subscription login isn't allowed in third-party tools, so there's no OAuth.
// All settings come from config.ts, using Claude Code's variable names.

export type ClaudeTransport = "anthropic" | "bedrock";

const MAX_TOKENS = 32_000;
const RETRIES = 3;
const CONTEXT_WINDOW = 200_000;
// Server-side compaction on demand. The Claude API has it, Bedrock doesn't, so Bedrock uses our own summary.
const COMPACT_BETA = "compact-2026-09-04";
// Adaptive thinking with summaries on. Newer models think by default but hide it ("omitted"), so nothing
// shows while they think. Models before 4.6 reject adaptive, and the request is retried without it.
const THINKING = { type: "adaptive", display: "summarized" };
// Server-side web search, on the Claude API only (Bedrock doesn't have it, so it gets the local tool).
// The basic version, since later ones need code execution and a model that supports it.
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search" };
// A long search turn can come back paused. Each continuation resends the partial reply.
const MAX_CONTINUATIONS = 5;

// Fallback ids for the direct API. Bedrock needs ANTHROPIC_DEFAULT_<ALIAS>_MODEL, since ids and ARNs are per account.
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

type Block = Record<string, any>;

// A 200 with no Claude events. Nothing reached the caller, so the request can be sent again.
class NoReply extends Error {}
type Endpoint = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

export function resolveClaudeModel(name: string, transport: ClaudeTransport, config: Config): string {
  const alias = name.replace(/\[.*\]$/, "").toLowerCase(); // Claude Code allows "opus[1m]"
  if (!(alias in ALIASES)) return name;
  const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
  const configured = config.get(key);
  if (configured) return configured;
  if (transport === "anthropic") return ALIASES[alias]!;
  throw new Error(`Set ${key} to a Bedrock model id or inference profile ARN.`);
}

export function claudeProvider(transport: ClaudeTransport, model: string, config: Config): Provider {
  const endpoint = transport === "bedrock" ? bedrockEndpoint(model, config) : anthropicEndpoint(model, config);
  // HARNESS_EFFORT is low, medium, high, xhigh or max. Unset leaves the API default (high).
  const effort = config.get("HARNESS_EFFORT");
  const settings: Record<string, string> = { effort: effort ?? "default (high)", thinking: "adaptive, summarized" };
  let thinking = true;
  // Set once the endpoint answers a request with nothing and only answers again without the older images.
  // Some gateways cap the request size and fail silently past it, and screenshots add up.
  let dropImages = false;
  // HARNESS_WEB_SEARCH=local uses the harness's own search, for orgs that turned the server tool off.
  const hostedSearch = transport === "anthropic" && config.get("HARNESS_WEB_SEARCH") !== "local";

  async function send(req: CompletionRequest, extra: Record<string, unknown> = {}): Promise<Completion> {
    // Every request that carries a compaction block needs the beta header, not just the one that made it.
    const beta = extra.compaction || req.messages.some(isNativeSummary);
    const headers = beta ? withBeta(endpoint.headers, COMPACT_BETA) : endpoint.headers;
    let emptyReplies = 0;
    for (let attempt = 0; ; attempt++) {
      const sent = dropImages ? { ...req, messages: dropOlderAttachments(req.messages) } : req;
      const body = JSON.stringify({
        ...endpoint.body,
        ...requestBody(sent, hostedSearch),
        ...(thinking ? { thinking: THINKING } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        ...extra,
      });
      const res = await fetch(endpoint.url, { method: "POST", signal: req.signal, headers, body });
      if (res.ok) {
        // Bedrock streams AWS event frames. The direct API and some gateways stream SSE.
        const binary = res.headers.get("content-type")?.includes("amazon.eventstream");
        try {
          return await readStream(binary ? eventStreamEvents(res) : sseEvents(res), req);
        } catch (err) {
          if (!(err instanceof NoReply) || req.signal?.aborted) throw err;
          emptyReplies++;
          // Once as is, in case it was a blip. Then without the older images.
          if (emptyReplies === 1) continue;
          if (!dropImages && countAttachments(req.messages) > countAttachments(dropOlderAttachments(req.messages))) {
            dropImages = true;
            settings.images = "older images dropped (the endpoint sent nothing back with them)";
            continue;
          }
          throw new Error(`${err.message}\n${describeRequest(body, sent.messages, res)}`);
        }
      }
      const text = await res.text();
      if (thinking && res.status === 400 && /thinking|adaptive|display/i.test(text)) {
        thinking = false;
        settings.thinking = "model default (adaptive rejected)";
        continue;
      }
      // 429 rate limited, 529 overloaded, other 5xx: back off and retry.
      if (attempt < RETRIES && (res.status === 429 || res.status >= 500)) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
        await Bun.sleep(Math.min(wait, 20_000));
        continue;
      }
      throw new Error(`${transport} ${res.status}: ${text}`);
    }
  }

  return {
    name: transport,
    model,
    contextWindow: CONTEXT_WINDOW,
    settings,
    hostedTools: hostedSearch ? [{ name: "web_search", hint: webSearchTool.hint }] : [],
    // pause_turn means the server stopped a long search turn early. Sending the partial reply back resumes it,
    // and the continuation's blocks belong to the same assistant message.
    async complete(req) {
      let res = await send(req);
      for (let i = 0; res.stopReason === "pause_turn" && i < MAX_CONTINUATIONS; i++) {
        const partial: Message = { role: "assistant", text: res.text, toolCalls: [], raw: res.raw };
        const next = await send({ ...req, messages: [...req.messages, partial] });
        res = {
          ...next,
          text: res.text + next.text,
          toolCalls: [...res.toolCalls, ...next.toolCalls],
          raw: [...res.raw, ...next.raw],
          firstTokenMs: res.firstTokenMs,
        };
      }
      return res;
    },
    // The response is a single signed compaction block, which goes first in messages from then on.
    compact:
      transport === "anthropic"
        ? async (req) => {
            const res = await send(req, { compaction: { type: "summarize" } });
            const block = res.raw.find((b) => (b as Block).type === "compaction") as Block | undefined;
            return block && { role: "summary", text: String(block.content ?? ""), raw: block };
          }
        : undefined,
  };
}

function attachmentBlock(a: Attachment): Block {
  const source = { type: "base64", media_type: a.mediaType, data: a.data };
  return isPdf(a) ? { type: "document", title: a.name, source } : { type: "image", source };
}

const isPdf = (a: Attachment) => a.mediaType === "application/pdf";

function isNativeSummary(m: Message): boolean {
  return m.role === "summary" && (m.raw as Block | undefined)?.type === "compaction";
}

function withBeta(headers: Record<string, string>, beta: string): Record<string, string> {
  const existing = headers["anthropic-beta"];
  return { ...headers, "anthropic-beta": existing ? `${existing},${beta}` : beta };
}

function anthropicEndpoint(model: string, config: Config): Endpoint {
  const key = config.get("ANTHROPIC_API_KEY");
  const token = config.get("ANTHROPIC_AUTH_TOKEN");
  if (!key && !token) throw new Error("Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) to use the Anthropic API.");
  return {
    url: `${config.get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com"}/v1/messages`,
    headers: {
      ...(key ? { "x-api-key": key } : { authorization: `Bearer ${token}` }),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...customHeaders(config),
    },
    body: { model, stream: true },
  };
}

function bedrockEndpoint(model: string, config: Config): Endpoint {
  // Region from AWS_REGION, else from an inference profile ARN (arn:aws:bedrock:<region>:...).
  const region = config.get("AWS_REGION") ?? config.get("AWS_DEFAULT_REGION") ?? model.split(":")[3];
  const base = config.get("ANTHROPIC_BEDROCK_BASE_URL") ?? (region && `https://bedrock-runtime.${region}.amazonaws.com`);
  if (!base) throw new Error("Set AWS_REGION or ANTHROPIC_BEDROCK_BASE_URL.");

  // A gateway (CLAUDE_CODE_SKIP_BEDROCK_AUTH=1) or a Bedrock API key takes a bearer token.
  // Raw AWS credentials need SigV4 signing, which isn't built yet.
  const token = config.get("AWS_BEARER_TOKEN_BEDROCK") ?? config.get("ANTHROPIC_AUTH_TOKEN");
  if (!token && config.get("CLAUDE_CODE_SKIP_BEDROCK_AUTH") !== "1") {
    throw new Error(
      "Bedrock needs AWS_BEARER_TOKEN_BEDROCK, or a gateway with CLAUDE_CODE_SKIP_BEDROCK_AUTH=1. SigV4 isn't supported yet.",
    );
  }
  return {
    // Same path the Anthropic Bedrock SDK builds, appended to the base URL. The model (often an ARN) goes in the path.
    url: `${base.replace(/\/+$/, "")}/model/${encodeURIComponent(model)}/invoke-with-response-stream`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/vnd.amazon.eventstream",
      ...customHeaders(config),
    },
    body: { anthropic_version: "bedrock-2023-05-31" },
  };
}

// ANTHROPIC_CUSTOM_HEADERS is newline-separated "Name: value" pairs, as in Claude Code.
function customHeaders(config: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (config.get("ANTHROPIC_CUSTOM_HEADERS") ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function requestBody(req: CompletionRequest, hostedSearch: boolean) {
  return {
    max_tokens: MAX_TOKENS,
    // Cache breakpoint on the system prompt. Tools render before it, so both stay cached all session.
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    tools: [
      ...req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      ...(hostedSearch ? [WEB_SEARCH] : []),
    ],
    messages: toMessages(req.messages),
  };
}

// Images and PDFs before the latest prompt, swapped for a note. The latest prompt keeps its own.
function dropOlderAttachments(messages: Message[]): Message[] {
  const latest = messages.findLastIndex((m) => m.role === "user");
  return messages.map((m, i) => {
    if (i >= latest || (m.role !== "user" && m.role !== "tool") || !m.attachments?.length) return m;
    const note = `[${m.attachments.map((a) => a.name).join(", ")} removed from the history to keep the request small]`;
    return m.role === "user"
      ? { ...m, attachments: undefined, text: `${m.text}\n${note}` }
      : { ...m, attachments: undefined, output: `${m.output}\n${note}` };
  });
}

const countAttachments = (messages: Message[]) =>
  messages.reduce((n, m) => n + ((m.role === "user" || m.role === "tool") && m.attachments ? m.attachments.length : 0), 0);

// What went out and what came back, for errors the endpoint doesn't explain.
function describeRequest(body: string, messages: Message[], res: Response): string {
  const header = (name: string) => res.headers.get(name) ?? "none";
  const requestId = res.headers.get("x-amzn-requestid") ?? res.headers.get("request-id") ?? "none";
  return [
    `Request ${(body.length / 1e6).toFixed(2)} MB, ${messages.length} messages, ${countAttachments(messages)} images or PDFs.`,
    `Response ${res.status}, content-type ${header("content-type")}, content-length ${header("content-length")}, request id ${requestId}.`,
    `Start a new session and run \`foxy-harness transcript\` there to carry this one's context over.`,
  ].join("\n");
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

  // Images go inside tool_result. PDFs follow the batch of results as document blocks instead
  // (tool_result blocks have to come first in the user message).
  let pending: Block[] = [];
  const flush = () => {
    push("user", pending);
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== "tool") flush();
    if (m.role === "user") push("user", [...(m.attachments ?? []).map(attachmentBlock), { type: "text", text: m.text }]);
    else if (m.role === "summary") {
      if (isNativeSummary(m)) push("assistant", [m.raw as Block]);
      else push("user", [{ type: "text", text: SUMMARY_PREFIX + m.text }]);
    } else if (m.role === "tool") {
      const images = (m.attachments ?? []).filter((a) => !isPdf(a));
      const content = images.length ? [{ type: "text", text: m.output }, ...images.map(attachmentBlock)] : m.output;
      push("user", [{ type: "tool_result", tool_use_id: m.callId, content }]);
      pending.push(...(m.attachments ?? []).filter(isPdf).map(attachmentBlock));
    } else if (m.raw) push("assistant", m.raw as Block[]);
    else {
      push("assistant", [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
      ]);
    }
  }
  flush();

  // A second, moving breakpoint on the newest block, so each step reuses the cached conversation.
  // Thinking blocks can't carry one, which only matters when a paused turn ends on one.
  const last = out.at(-1);
  const block = last?.content.at(-1);
  if (last && block && !/thinking/.test(block.type))
    last.content[last.content.length - 1] = { ...block, cache_control: { type: "ephemeral" } };
  return out;
}

async function readStream(events: AsyncIterable<any>, { onText, onReasoning, onServerTool }: CompletionRequest): Promise<Completion> {
  const started = performance.now();
  const out: Completion = { text: "", toolCalls: [], raw: [], usage: {} };
  const blocks: Block[] = [];
  const json: string[] = [];
  let sawStart = false;
  // Whatever arrived instead of Claude's events, for the error below.
  const unknown: string[] = [];

  for await (const ev of events) {
    if (!sawStart && ev?.type !== "message_start" && unknown.length < 3) unknown.push(JSON.stringify(ev).slice(0, 700));
    switch (ev.type) {
      case "message_start": {
        sawStart = true;
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
        if (b.type === "tool_use" || b.type === "server_tool_use") b.input = parseJson(json[ev.index] ?? "");
        if (b.type === "tool_use") out.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        // The search ran between the two blocks. Its results arrive whole in content_block_start.
        if (b.type === "web_search_tool_result") {
          const use = blocks.find((u) => u?.type === "server_tool_use" && u.id === b.tool_use_id);
          onServerTool?.({ id: b.tool_use_id, name: use?.name ?? "web_search", input: use?.input ?? {}, ...searchOutput(b.content) });
        }
        // Summarized thinking arrives whole before the block stops. Hidden ("omitted") thinking is empty.
        if (b.type === "thinking") {
          const line = reasoningHeading(b.thinking ?? "");
          if (line) onReasoning?.(line);
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) out.stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) out.usage.outputTokens = ev.usage.output_tokens;
        if (ev.usage?.output_tokens_details?.thinking_tokens != null)
          out.usage.thinkingTokens = ev.usage.output_tokens_details.thinking_tokens;
        break;
      case "error":
        throw new Error(`claude stream error: ${JSON.stringify(ev.error)}`);
    }
  }
  // A gateway or proxy that answers 200 without Claude's events would otherwise look like an empty reply.
  if (!sawStart)
    throw new NoReply(
      `claude stream ended before message_start. The endpoint answered but sent ${unknown.length ? `this instead: ${unknown.join("\n")}` : "nothing"}.`,
    );
  // Replayed verbatim next turn (thinking blocks need their signatures). Empty text blocks are rejected.
  out.raw = blocks.filter((b) => b && !(b.type === "text" && !b.text));
  return out;
}

// content is a list of results, or one error object.
function searchOutput(content: any): { output: string; ok: boolean } {
  if (!Array.isArray(content)) return { output: `Search failed: ${content?.error_code ?? "unknown error"}`, ok: false };
  if (!content.length) return { output: "No results.", ok: true };
  return { output: content.map((r: Block) => `${r.title}\n  ${r.url}`).join("\n"), ok: true };
}

function parseJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __parse_error: s };
  }
}
