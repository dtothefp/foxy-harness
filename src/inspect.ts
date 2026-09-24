import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import type { Message, Usage } from "./providers/types.ts";

// A plain-text summary of a session, short enough to read off a photo of the screen: provider, settings,
// and per step what the model sent back (thinking shown or hidden, text, tool calls) with token counts.
// `foxy-harness last` prints the newest session file, `/session` the current one.

export type Session = {
  provider?: string;
  model: string;
  settings?: Record<string, string>;
  cwd: string;
  messages: Message[];
};

type Item = Record<string, any>;

const SESSIONS = join(HARNESS_HOME, "sessions");

// Newest session file, or the one whose id starts with `prefix`.
export async function findSession(prefix?: string): Promise<{ id: string; path: string; mtime: Date } | undefined> {
  const names = (await readdir(SESSIONS).catch(() => [])).filter((n) => n.endsWith(".json") && n.startsWith(prefix ?? ""));
  const files = await Promise.all(names.map(async (n) => ({ id: n.slice(0, -5), path: join(SESSIONS, n), mtime: (await stat(join(SESSIONS, n))).mtime })));
  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
}

export function describeSession(s: Session, header?: string): string {
  const out: string[] = [];
  if (header) out.push(header);
  out.push(`${s.provider ?? "provider not recorded"} · ${shortModel(s.model)}`);
  const settings = Object.entries(s.settings ?? {}).map(([k, v]) => `${k} ${v}`);
  out.push(settings.length ? settings.join(" · ") : "settings not recorded (older session)");
  out.push(s.cwd.replace(homedir(), "~"), "");

  let turn = 0;
  let step = 0;
  const total: Required<Usage> = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thinkingTokens: 0 };
  for (const m of s.messages) {
    if (m.role === "user") {
      step = 0;
      const attachments = m.attachments?.length ? ` (+${m.attachments.length} attached)` : "";
      out.push(`${++turn}  › ${oneLine(m.text, 60)}${attachments}`);
    } else if (m.role === "summary") {
      out.push(`   compacted (${m.raw ? "server-side" : "own summary"})`);
    } else if (m.role === "assistant") {
      const parts = (m.raw as Item[] | undefined)?.map(describeItem) ?? [m.text && `text ${m.text.length}`];
      out.push(`   step ${++step}  ${parts.filter(Boolean).join(" · ") || "empty"}`);
      if (m.usage) {
        out.push(`           ${usageLine(m.usage)}`);
        for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += m.usage[k] ?? 0;
      }
    }
  }
  out.push("", `total  ${usageLine(total)}`);
  return out.join("\n");
}

function describeItem(b: Item): string | undefined {
  switch (b.type) {
    // Claude. Empty thinking with a signature means the model thought but display was "omitted".
    case "thinking":
      return b.thinking ? `thinking ${b.thinking.length} chars "${oneLine(b.thinking.replace(/\*\*/g, ""), 40)}"` : "thinking hidden";
    case "redacted_thinking":
      return "thinking redacted";
    case "text":
      return `text ${b.text?.length ?? 0}`;
    case "tool_use":
      return `tool ${b.name}`;
    case "compaction":
      return "compaction";
    // Codex. Reasoning is encrypted, with an optional readable summary.
    case "reasoning": {
      const summary = (b.summary ?? []).map((p: Item) => p.text ?? "").join(" ");
      return summary ? `reasoning ${summary.length} chars "${oneLine(summary.replace(/\*\*/g, ""), 40)}"` : "reasoning hidden";
    }
    case "message":
      return `text ${(b.content ?? []).reduce((n: number, c: Item) => n + (c.text?.length ?? 0), 0)}`;
    case "function_call":
      return `tool ${b.name}`;
    default:
      return b.type;
  }
}

function usageLine(u: Usage): string {
  const thinking = u.thinkingTokens ? ` (thinking ${k(u.thinkingTokens)})` : "";
  return `in ${k(u.inputTokens)} (cached ${k(u.cachedTokens)}) · out ${k(u.outputTokens)}${thinking}`;
}

const k = (n = 0) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

// An inference profile ARN carries the account id. Show only the part after the last slash.
export const shortModel = (m: string) => (m.startsWith("arn:") ? `…/${m.split("/").at(-1)}` : m);

function oneLine(s: string, max: number): string {
  const line = s.trim().split("\n")[0]!;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function ago(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
}
