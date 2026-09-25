import { basename, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import type { Agent } from "./agent.ts";
import { ATTACHABLE, loadAttachment } from "./attachments.ts";
import { chooseProvider, type Frontend, type PreToolUse, startSession } from "./bootstrap.ts";
import type { Config } from "./config.ts";
import type { HookResult, Hooks } from "./events.ts";
import type { Attachment, Message, Usage } from "./providers/types.ts";
import { loadSession, type Session, sessionFiles, sessionPath, sessionTitle } from "./sessions.ts";
import type { FileChange } from "./tools/types.ts";

// Agent Client Protocol v1 (agentclientprotocol.com), so editors and session managers (Zed, Paseo) can drive
// the harness the way they drive other agents. JSON-RPC 2.0, one message per line on stdin and stdout.
// Stdout carries protocol messages only, so anything else that prints goes to stderr.
//
// Tools run here, in the session's cwd, not through the client's fs and terminal methods. Permission
// questions go to the client as session/request_permission. MCP servers the client passes are ignored for now.

type Id = number | string;
type Rpc = { id?: Id | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Update = Record<string, unknown> & { sessionUpdate: string };

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

// A session open on this connection.
type Live = {
  id: string;
  cwd: string;
  agent: Agent;
  hooks: Hooks;
  current?: AbortController;
  // How the last turn ended, from the Stop event.
  stop: string;
  // Chunks of one model reply share an id. A new step starts a new one.
  messageId?: string;
  // Tool calls already reported to the client, so the start is an update rather than a second tool_call.
  announced: Set<string>;
  // "Always allow" answers, by kind of call (bash or edit), for the rest of the session.
  allowed: Set<string>;
};

const PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

const EDIT_TOOLS = new Set(["edit_file", "apply_patch"]);
const PAGE = 50;

export async function runAcp(config: Config, flags: { provider?: string; model?: string; yolo: boolean }): Promise<never> {
  console.log = console.error;
  const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const sessions = new Map<string, Live>();

  let nextId = 0;
  const replies = new Map<Id, (m: Rpc) => void>();
  const request = (method: string, params: object) =>
    new Promise<Rpc>((done) => {
      const id = nextId++;
      replies.set(id, done);
      send({ id, method, params });
    });
  const update = (live: Live, u: Update) => send({ method: "session/update", params: { sessionId: live.id, update: u } });

  const get = (sessionId: string) => {
    const live = sessions.get(sessionId);
    if (!live) throw new RpcError(-32602, `Unknown session ${sessionId}`);
    return live;
  };

  async function open(id: string, cwd: string, resumed?: Session): Promise<Live> {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new RpcError(-32602, "cwd must be an absolute path");
    await close(id);
    const live = { id, cwd, stop: "end_turn", announced: new Set(), allowed: new Set() } as unknown as Live;
    const frontend: Frontend = {
      askPermission: flags.yolo ? undefined : (e) => askPermission(live, e),
      notice: (line) => console.error(`foxy-harness: ${line}`),
      onText: (text) => update(live, { sessionUpdate: "agent_message_chunk", messageId: (live.messageId ??= crypto.randomUUID()), content: { type: "text", text } }),
      onReasoning: (text) => update(live, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${text}\n` } }),
      onToolStart: (name, input, changes, callId) => {
        if (live.announced.has(callId)) update(live, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress" });
        else update(live, { ...toolCall(name, input, changes, callId, cwd), status: "in_progress" });
        live.announced.add(callId);
      },
      onToolEnd: (output, ok, changes, name, _input, callId) => {
        live.announced.delete(callId);
        update(live, { sessionUpdate: "tool_call_update", toolCallId: callId, status: ok ? "completed" : "failed", content: toolOutput(output, ok, changes, name, cwd), rawOutput: { output } });
      },
      onStep: ({ usage }) => {
        live.messageId = undefined;
        const u = usage as Usage;
        if (u.inputTokens != null) update(live, { sessionUpdate: "usage_update", used: u.inputTokens + (u.outputTokens ?? 0), size: live.agent.contextWindow });
      },
      onCompact: (info) => {
        const k = (n: number) => `${Math.round(n / 1000)}k`;
        const text =
          info.kind === "summary" ? `Compacted conversation (~${k(info.before)} → ~${k(info.after)} tokens)` : info.kind === "failed" ? `Compaction failed: ${info.error}` : undefined;
        if (text) update(live, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${text}\n` } });
      },
    };
    let started: Awaited<ReturnType<typeof startSession>>;
    try {
      started = await startSession({ config, cwd, sessionId: id, choice: chooseProvider(config, flags, resumed), frontend, resumed });
    } catch (err) {
      throw new RpcError(-32603, err instanceof Error ? err.message : String(err));
    }
    live.agent = started.agent;
    live.hooks = started.hooks;
    live.hooks.on("Stop", (e) => void (live.stop = e.reason));
    sessions.set(id, live);
    return live;
  }

  async function close(id: string) {
    const live = sessions.get(id);
    if (!live) return;
    live.current?.abort();
    sessions.delete(id);
    await live.hooks.emit({ type: "SessionEnd", sessionId: id });
  }

  // Reports the call, then asks the client. The request repeats the call's title, kind and diff, since some
  // clients (aoe) show the request as its own card. A cancelled turn answers for the client.
  async function askPermission(live: Live, e: PreToolUse): Promise<HookResult> {
    const { sessionUpdate: _, ...call } = toolCall(e.tool, e.input, e.changes, e.callId, live.cwd);
    update(live, { sessionUpdate: "tool_call", ...call });
    live.announced.add(e.callId);
    const kind = e.changes ? "edit" : e.tool;
    if (live.allowed.has(kind)) return;
    const signal = live.current?.signal;
    const cancelled = new Promise<undefined>((done) => signal?.addEventListener("abort", () => done(undefined), { once: true }));
    const reply = await Promise.race([request("session/request_permission", { sessionId: live.id, toolCall: call, options: PERMISSION_OPTIONS }), cancelled]);
    const outcome = reply?.result?.outcome as { outcome: string; optionId?: string } | undefined;
    if (outcome?.outcome === "selected" && outcome.optionId?.startsWith("allow")) {
      if (outcome.optionId === "allow_always") live.allowed.add(kind);
      return;
    }
    live.announced.delete(e.callId);
    update(live, { sessionUpdate: "tool_call_update", toolCallId: e.callId, status: "failed" });
    return { block: outcome?.outcome === "selected" ? "user declined" : "cancelled" };
  }

  // A saved history, as the updates the client would have seen.
  function replay(live: Live, messages: Message[]) {
    const denied = new Set(messages.flatMap((m) => (m.role === "tool" && m.output.startsWith("Tool call denied") ? [m.callId] : [])));
    for (const m of messages) {
      const messageId = crypto.randomUUID();
      if (m.role === "user") update(live, { sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: m.text } });
      if (m.role === "summary") update(live, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: m.raw ? "_Earlier messages were compacted._" : m.text } });
      if (m.role !== "assistant") continue;
      if (m.text) update(live, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: m.text } });
      for (const c of m.toolCalls) update(live, { ...toolCall(c.name, c.input, undefined, c.id, live.cwd), status: denied.has(c.id) ? "failed" : "completed" });
    }
  }

  async function saved(sessionId: string): Promise<Session> {
    const file = Bun.file(sessionPath(sessionId));
    if (!(await file.exists())) throw new RpcError(-32002, `No saved session ${sessionId}`);
    return loadSession(sessionPath(sessionId));
  }

  const handlers: Record<string, (p: any) => Promise<unknown>> = {
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "foxy-harness", title: "foxy-harness", version: pkg.version },
      authMethods: [],
    }),
    authenticate: async () => ({}),

    "session/new": async ({ cwd }) => {
      const id = crypto.randomUUID();
      await open(id, cwd);
      return { sessionId: id };
    },
    "session/load": async ({ sessionId, cwd }) => {
      const session = await saved(sessionId);
      replay(await open(sessionId, cwd, session), session.messages);
      return {};
    },
    "session/resume": async ({ sessionId, cwd }) => {
      await open(sessionId, cwd, await saved(sessionId));
      return {};
    },
    "session/close": async ({ sessionId }) => {
      get(sessionId);
      await close(sessionId);
      return {};
    },
    // Newest first. The cursor is an index into the session files, since loading every file is slow.
    "session/list": async ({ cwd, cursor }) => {
      const files = await sessionFiles();
      const out: object[] = [];
      let i = Number(cursor) || 0;
      for (; i < files.length && out.length < PAGE; i++) {
        const s = await loadSession(files[i]!.path).catch(() => undefined);
        if (!s || (cwd && s.cwd !== cwd) || !s.messages.some((m) => m.role === "user")) continue;
        out.push({ sessionId: files[i]!.id, cwd: s.cwd, title: sessionTitle(s).slice(0, 100) || null, updatedAt: files[i]!.mtime.toISOString() });
      }
      return { sessions: out, nextCursor: i < files.length ? String(i) : null };
    },

    "session/prompt": async ({ sessionId, prompt }) => {
      const live = get(sessionId);
      if (live.current) throw new RpcError(-32600, "A turn is already running in this session");
      const { text, attachments } = await toPrompt(prompt ?? [], live.cwd);
      const controller = new AbortController();
      live.current = controller;
      live.stop = "end_turn";
      try {
        await live.agent.run(text, controller.signal, attachments);
      } catch (err) {
        if (!controller.signal.aborted) throw new RpcError(-32603, err instanceof Error ? err.message : String(err));
      } finally {
        live.current = undefined;
        live.messageId = undefined;
      }
      update(live, { sessionUpdate: "session_info_update", title: sessionTitle(live.agent.snapshot()).slice(0, 100), updatedAt: new Date().toISOString() });
      return { stopReason: controller.signal.aborted ? "cancelled" : live.stop === "max_steps" ? "max_turn_requests" : "end_turn" };
    },
    "session/cancel": async ({ sessionId }) => {
      sessions.get(sessionId)?.current?.abort();
    },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return send({ id: null, error: { code: -32700, message: "Parse error" } });
    }
    // A reply to one of our requests.
    if (!msg.method) {
      replies.get(msg.id!)?.(msg);
      replies.delete(msg.id!);
      return;
    }
    const handler = handlers[msg.method];
    // Notifications get no reply, even on failure.
    if (msg.id == null) return void handler?.(msg.params ?? {}).catch((err) => console.error(`foxy-harness: ${msg.method}: ${err}`));
    if (!handler) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    try {
      send({ id: msg.id, result: (await handler(msg.params ?? {})) ?? {} });
    } catch (err) {
      const error = err instanceof RpcError ? { code: err.code, message: err.message } : { code: -32603, message: err instanceof Error ? err.message : String(err) };
      send({ id: msg.id, error });
    }
  });
  await new Promise((done) => rl.on("close", done));
  for (const id of [...sessions.keys()]) await close(id);
  process.exit(0);
}

// ACP content blocks to a prompt. Text is kept in order. A linked file is named by path so the model can
// read it, and images and PDFs are attached. Embedded file contents follow the prompt.
async function toPrompt(blocks: any[], cwd: string): Promise<{ text: string; attachments: Attachment[] }> {
  const parts: string[] = [];
  const context: string[] = [];
  const attachments: Attachment[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "image") attachments.push({ name: b.uri ? basename(b.uri) : "image", mediaType: b.mimeType, data: b.data });
    else if (b.type === "resource_link") {
      const path = filePath(b.uri);
      if (path && ATTACHABLE.test(path)) {
        try {
          attachments.push(await loadAttachment(path));
        } catch (err) {
          context.push(`Couldn't attach ${path}: ${err instanceof Error ? err.message : err}`);
        }
      }
      parts.push(`@${path ?? b.uri}`);
    } else if (b.type === "resource") {
      const r = b.resource;
      const path = filePath(r.uri) ?? r.uri;
      if (typeof r.text === "string") context.push(`<file path="${path}">\n${r.text}\n</file>`);
      else if (/^image\/|^application\/pdf$/.test(r.mimeType ?? "")) attachments.push({ name: basename(path), mediaType: r.mimeType, data: r.blob });
    }
  }
  return { text: [parts.join(""), ...context].join("\n\n").trim() || "(empty prompt)", attachments };

  function filePath(uri: string): string | undefined {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(uri)) return resolve(cwd, uri);
  }
}

// How the client shows a call: a title, a kind for the icon, the files it touches, and a diff for edits.
function toolCall(name: string, input: unknown, changes: FileChange[] | undefined, callId: string, cwd: string): Update {
  const args = (input ?? {}) as { command?: string; description?: string; path?: string; offset?: number };
  const base = { sessionUpdate: "tool_call", toolCallId: callId, name, status: "pending", rawInput: input };
  if (changes) {
    return {
      ...base,
      title: `Edit ${changes.map((c) => c.moveTo ?? c.path).join(", ")}`,
      kind: changes.every((c) => c.kind === "delete") ? "delete" : "edit",
      content: diffs(changes, cwd),
      locations: changes.map((c) => ({ path: resolve(cwd, c.moveTo ?? c.path) })),
    };
  }
  if (name === "bash") {
    const command = args.command ?? "";
    return { ...base, title: args.description?.trim() || command.split("\n")[0] || "bash", kind: "execute", content: [text(`$ ${command}`)] };
  }
  if (name === "read_file" && args.path) {
    return { ...base, title: `Read ${args.path}`, kind: "read", locations: [{ path: resolve(cwd, args.path), line: args.offset ?? null }] };
  }
  if (EDIT_TOOLS.has(name)) return { ...base, title: args.path ? `Edit ${args.path}` : "Edit files", kind: "edit" };
  return { ...base, title: name, kind: "other" };
}

// What the client shows when a call ends. File reads show nothing, the model's reply covers them.
function toolOutput(output: string, ok: boolean, changes: FileChange[] | undefined, name: string, cwd: string) {
  if (ok && changes) return diffs(changes, cwd);
  if (ok && name === "read_file") return [];
  const max = 8000;
  return [text(output.length > max ? `${output.slice(0, max)}\n… ${output.length - max} more characters` : output)];
}

const text = (t: string) => ({ type: "content", content: { type: "text", text: t } });

const diffs = (changes: FileChange[], cwd: string) =>
  changes.map((c) => ({
    type: "diff",
    path: resolve(cwd, c.moveTo ?? c.path),
    oldText: c.kind === "add" ? null : c.before,
    newText: c.kind === "delete" ? "" : c.after,
  }));
