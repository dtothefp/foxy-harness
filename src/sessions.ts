import { rmSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import type { Message } from "./providers/types.ts";
import { SHELL_NOTE } from "./shell.ts";

// Saved sessions, one JSON file per session id. Resume works like Claude Code's. --continue picks the
// newest session in the current directory, --resume <id> a given one, --resume alone lists them.

export type Session = {
  provider?: string;
  model: string;
  settings?: Record<string, string>;
  cwd: string;
  branch?: string;
  // Written by a small model after the first few turns (titles.ts).
  title?: string;
  messages: Message[];
};

export type SessionFile = { id: string; path: string; mtime: Date };

export const SESSIONS = join(HARNESS_HOME, "sessions");
export const sessionPath = (id: string) => join(SESSIONS, `${id}.json`);

// Newest first. Ids starting with `prefix` only, when given.
export async function sessionFiles(prefix = ""): Promise<SessionFile[]> {
  const names = (await readdir(SESSIONS).catch(() => [])).filter((n) => n.endsWith(".json") && n.startsWith(prefix));
  const files = await Promise.all(
    names.map(async (n) => ({ id: n.slice(0, -5), path: join(SESSIONS, n), mtime: (await stat(join(SESSIONS, n))).mtime })),
  );
  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

// Newest session file, or the newest whose id starts with `prefix`.
export async function findSession(prefix?: string): Promise<SessionFile | undefined> {
  return (await sessionFiles(prefix))[0];
}

export const loadSession = (path: string) => Bun.file(path).json() as Promise<Session>;

// The newest `limit` sessions started in `cwd` (any directory without it), with their contents.
export async function sessionsIn(cwd: string | undefined, limit: number): Promise<(SessionFile & { session: Session })[]> {
  const out: (SessionFile & { session: Session })[] = [];
  for (const file of await sessionFiles()) {
    const session = await loadSession(file.path).catch(() => undefined);
    if (session && (!cwd || session.cwd === cwd) && session.messages.some((m) => m.role === "user")) out.push({ ...file, session });
    if (out.length >= limit) break;
  }
  return out;
}

// A pid file marks a session open in a running foxy-harness. It's removed on exit, so one left behind by a
// process that's gone means the session ended without exiting, from a crash or the terminal closing.
const pidPath = (id: string) => join(SESSIONS, `${id}.pid`);

export async function markOpen(id: string) {
  await mkdir(SESSIONS, { recursive: true });
  await Bun.write(pidPath(id), String(process.pid));
  process.on("exit", () => rmSync(pidPath(id), { force: true }));
}

export const markClosed = (id: string) => rm(pidPath(id), { force: true });

export async function sessionState(id: string): Promise<"open" | "interrupted" | undefined> {
  const pid = Number(
    await Bun.file(pidPath(id))
      .text()
      .catch(() => ""),
  );
  if (!pid) return;
  try {
    process.kill(pid, 0);
    return "open";
  } catch (err) {
    // EPERM means it's running as someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "open" : "interrupted";
  }
}

// Histories hold each provider's raw items, so a session only resumes in its own family.
// Older session files didn't record the provider, so fall back to the model name.
export const providerFamily = (provider?: string, model = "") =>
  provider === "codex" || (!provider && /^(gpt|codex|o\d)/i.test(model)) ? "codex" : "claude";

// The generated title, or else the first thing the user asked, for the session list.
export function sessionTitle(s: Session): string {
  if (s.title) return s.title;
  const first = s.messages.find((m) => m.role === "user" && !m.text.startsWith(SHELL_NOTE));
  if (first?.role !== "user") return "";
  // A /skill prompt was sent with the skill's instructions ahead of it (see expandSkill).
  const skill = /^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*([\s\S]*)$/.exec(first.text);
  const text = skill ? `/${skill[1]} ${skill[2]}` : first.text;
  return text.trim().split("\n")[0]!;
}
