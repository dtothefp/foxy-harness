import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import type { Message } from "./providers/types.ts";

// Saved sessions, one JSON file per session id. Resume works like Claude Code's. --continue picks the
// newest session in the current directory, --resume <id> a given one, --resume alone lists them.

export type Session = {
  provider?: string;
  model: string;
  settings?: Record<string, string>;
  cwd: string;
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

// The newest `limit` sessions started in `cwd`, with their contents.
export async function sessionsIn(cwd: string, limit: number): Promise<(SessionFile & { session: Session })[]> {
  const out: (SessionFile & { session: Session })[] = [];
  for (const file of await sessionFiles()) {
    const session = await loadSession(file.path).catch(() => undefined);
    if (session?.cwd === cwd && session.messages.some((m) => m.role === "user")) out.push({ ...file, session });
    if (out.length >= limit) break;
  }
  return out;
}

// Histories hold each provider's raw items, so a session only resumes in its own family.
// Older session files didn't record the provider, so fall back to the model name.
export const providerFamily = (provider?: string, model = "") =>
  provider === "codex" || (!provider && /^(gpt|codex|o\d)/i.test(model)) ? "codex" : "claude";

// The first thing the user asked, for the session list.
export function sessionTitle(s: Session): string {
  const first = s.messages.find((m) => m.role === "user");
  return first?.role === "user" ? first.text.trim().split("\n")[0]! : "";
}
