import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { HARNESS_HOME } from "./auth/codex-oauth.ts";
import type { Hooks } from "./events.ts";

// Instruction files and skills, from the places Claude Code and Codex keep them.
//
// Instructions use a two-level, monorepo-style rule instead of walking up to the git root:
//   local    AGENTS.md (else CLAUDE.md) in the launch directory
//   global   ~/.foxy-harness/AGENTS.md, ~/.codex/AGENTS.md or ~/.claude/CLAUDE.md, only when there's no local file
//   package  when a tool touches a file under a subdirectory with its own AGENTS.md/CLAUDE.md,
//            that file is added once, next to the tool result
//
// Skills are indexed by name and description only. The model reads SKILL.md when a task matches.

const NAMES = ["AGENTS.md", "CLAUDE.md"];
const HOME = homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
const GLOBAL_INSTRUCTIONS = [join(HARNESS_HOME, "AGENTS.md"), join(HOME, ".codex", "AGENTS.md"), join(CLAUDE_DIR, "CLAUDE.md")];
const SKILL_DIRS = [".claude/skills", ".agents/skills", ".codex/skills"];
const GLOBAL_SKILL_DIRS = [join(CLAUDE_DIR, "skills"), join(HOME, ".agents", "skills"), join(HOME, ".codex", "skills")];
const MAX_DESCRIPTION = 300;

export type Instructions = { path: string; text: string };
export type Skill = { name: string; description: string; path: string };

async function firstExisting(paths: string[]): Promise<Instructions | undefined> {
  for (const path of paths) {
    const file = Bun.file(path);
    if (await file.exists()) return { path, text: await file.text() };
  }
}

export async function loadInstructions(cwd: string): Promise<Instructions | undefined> {
  return (await firstExisting(NAMES.map((n) => join(cwd, n)))) ?? (await firstExisting(GLOBAL_INSTRUCTIONS));
}

// Adds a package's instructions the first time a tool touches a file inside it.
// Only the nearest file between the touched path and the launch directory counts.
export function watchPackageInstructions(
  hooks: Hooks,
  cwd: string,
  loaded: Instructions | undefined,
  onLoad?: (path: string) => void,
) {
  const seen = new Set<string>();
  const byDir = new Map<string, Promise<Instructions | undefined>>();
  if (loaded) realpath(loaded.path).then((p) => seen.add(p), () => {});

  const nearest = async (dir: string): Promise<Instructions | undefined> => {
    const rel = relative(cwd, dir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return; // the launch dir itself, or outside it
    if (!byDir.has(dir)) {
      byDir.set(dir, firstExisting(NAMES.map((n) => join(dir, n))).then((found) => found ?? nearest(dirname(dir))));
    }
    return byDir.get(dir);
  };

  hooks.on("PostToolUse", async (e) => {
    if (!e.ok) return;
    const input = e.input as { path?: unknown };
    const touched = e.changes
      ? e.changes.flatMap((c) => (c.moveTo ? [c.path, c.moveTo] : [c.path]))
      : typeof input?.path === "string"
        ? [input.path]
        : [];

    const added: string[] = [];
    for (const p of touched) {
      const abs = resolve(cwd, p);
      const found = await nearest(dirname(abs));
      if (!found) continue;
      const real = await realpath(found.path).catch(() => found.path);
      if (seen.has(real)) continue;
      seen.add(real);
      // The model just read the instruction file itself. Don't repeat it.
      if (real === (await realpath(abs).catch(() => abs))) continue;
      const rel = relative(cwd, found.path);
      onLoad?.(rel);
      added.push(`<instructions path="${rel}">\nInstructions for files under ${dirname(rel)}/. Follow them there.\n\n${found.text}\n</instructions>`);
    }
    if (added.length) return { context: added.join("\n\n") };
  });
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  // Local dirs first, so a project skill wins over a global one with the same name.
  const roots = [...SKILL_DIRS.map((d) => join(cwd, d)), ...GLOBAL_SKILL_DIRS];
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      const path = join(root, entry, "SKILL.md");
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const meta = frontmatter(await file.text());
      const name = meta.name || entry;
      if (byName.has(name) || meta["disable-model-invocation"] === "true") continue;
      const description = meta.description ?? "";
      byName.set(name, {
        name,
        description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
        path: relative(cwd, path).startsWith("..") ? path : relative(cwd, path),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Just enough YAML for SKILL.md headers: `key: value`, quoted values, and folded/literal blocks (`>`, `|`).
function frontmatter(text: string): Record<string, string> {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const out: Record<string, string> = {};
  let key: string | undefined;
  for (const line of block?.split(/\r?\n/) ?? []) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1]!;
      out[key] = /^[>|][-+]?$/.test(kv[2]!) ? "" : kv[2]!.replace(/^(["'])(.*)\1$/, "$2");
    } else if (key && /^\s/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}
