import { dirname, resolve } from "node:path";
import type { Skill } from "./context.ts";

// Slash commands. The built-ins, plus every skill as /<skill-name>, the same as Claude Code.

export type Command = { name: string; description: string; skill?: Skill };

export const BUILTINS: Command[] = [
  { name: "model", description: "Switch the model, or list the named aliases" },
  { name: "session", description: "Show what the model sent back this session" },
  { name: "compact", description: "Summarize the conversation to free up context" },
];

export function commands(skills: Skill[]): Command[] {
  const taken = new Set(BUILTINS.map((c) => c.name));
  return [...BUILTINS, ...skills.filter((s) => !taken.has(s.name)).map((s) => ({ name: s.name, description: s.description, skill: s }))];
}

// Commands for what's typed after the slash. Names that start with it, or have a word that does
// (`rev` finds code-review), come first. Only when there are none does it widen to names containing it,
// then names with its letters in order (`gcm` finds git-commit-message), then descriptions. Built-ins
// lead within a tier, then skills in name order.
export function matchCommands(all: Command[], query: string): Command[] {
  const q = query.toLowerCase();
  const tiers: ((name: string, c: Command) => boolean)[] = [
    (name) => name.startsWith(q),
    (name) => name.split(/[-_:.]/).some((word) => word.startsWith(q)),
    (name) => name.includes(q),
    (name) => inOrder(name, q),
    (_, c) => c.description.toLowerCase().includes(q),
  ];
  const seen = new Set<Command>();
  const found: Command[] = [];
  for (const [i, test] of tiers.entries()) {
    // Past the word tier, a wider match only shows when nothing closer did.
    if (i >= 2 && found.length) break;
    for (const c of all) {
      if (seen.has(c) || !test(c.name.toLowerCase(), c)) continue;
      seen.add(c);
      found.push(c);
    }
  }
  return found;
}

function inOrder(text: string, letters: string): boolean {
  let at = 0;
  for (const ch of letters) {
    at = text.indexOf(ch, at) + 1;
    if (!at) return false;
  }
  return true;
}

// `/skill-name what to do` becomes the skill's SKILL.md followed by the request, so the model starts on it
// without a read_file round trip. Returns undefined when the name isn't a skill.
export async function expandSkill(prompt: string, skills: Skill[], cwd: string): Promise<string | undefined> {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt);
  const skill = m && skills.find((s) => s.name === m[1]);
  if (!skill) return;
  const path = resolve(cwd, skill.path);
  const body = await Bun.file(path).text();
  const request = m[2]?.trim() || "Run this skill.";
  return `<skill name="${skill.name}" path="${skill.path}">\nPaths in this skill are relative to ${dirname(path)}.\n\n${body.trim()}\n</skill>\n\n${request}`;
}
