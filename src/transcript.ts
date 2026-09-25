import { homedir } from "node:os";
import type { Session } from "./sessions.ts";

// A session as plain text, for carrying context into another session. `foxy-harness transcript <id>` prints
// it, and the agent runs that through bash to read a session that can't be resumed. Images and PDFs become
// their names, tool calls one line each, and past `max` characters the oldest turns are cut.

const TOOL_OUTPUT = 400;
const TOOL_INPUT = 200;

export function transcript(id: string, s: Session, max = 60_000): string {
  const head = `session ${id.slice(0, 8)} · ${s.provider ?? "unknown provider"} · ${s.model} · ${s.cwd.replace(homedir(), "~")}`;
  const turns: string[] = [];
  let turn = "";
  for (const m of s.messages) {
    if (m.role === "user") {
      if (turn) turns.push(turn);
      turn = `## user\n${m.text.trim()}${attached(m.attachments)}\n`;
    } else if (m.role === "summary") {
      turn += `\n## summary of everything before this\n${m.text.trim()}\n`;
    } else if (m.role === "assistant") {
      if (m.text.trim()) turn += `\n## assistant\n${m.text.trim()}\n`;
      for (const c of m.toolCalls) turn += `\n→ ${c.name} ${clip(JSON.stringify(c.input), TOOL_INPUT)}`;
    } else {
      turn += `\n  ${clip(m.output.trim().replace(/\n/g, "\n  "), TOOL_OUTPUT)}${attached(m.attachments)}\n`;
    }
  }
  if (turn) turns.push(turn);

  // Keep the newest turns that fit.
  const kept: string[] = [];
  let size = head.length;
  for (const t of turns.toReversed()) {
    if (kept.length && size + t.length > max) break;
    kept.unshift(clip(t, max));
    size += t.length;
  }
  const cut = turns.length - kept.length;
  return [head, ...(cut ? [`(${cut} older turn${cut === 1 ? "" : "s"} left out)`] : []), "", ...kept].join("\n");
}

const attached = (a?: { name: string }[]) => (a?.length ? `\n[attached: ${a.map((x) => x.name).join(", ")}]` : "");
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more)`);
