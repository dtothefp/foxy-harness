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
//            that file is added once, next to the tool result. Package skills dirs load the same way.
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

// Adds a package's instructions and skills the first time a tool touches a file inside it.
// Instructions: only the nearest AGENTS.md/CLAUDE.md between the touched file and the launch directory.
// Skills: every skills dir between the touched file and the launch directory (nested packages stack).
export function watchPackages(
  hooks: Hooks,
  cwd: string,
  loaded: { instructions?: Instructions; skills: Skill[] },
  onLoad?: (what: string) => void,
) {
  const seen = new Set<string>(); // real paths of instruction files and SKILL.md files already in context
  const ready = Promise.all([
    ...(loaded.instructions ? [loaded.instructions.path] : []),
    ...loaded.skills.map((s) => resolve(cwd, s.path)),
  ].map((p) => realpath(p).then((r) => seen.add(r), () => {})));
  const byDir = new Map<string, Promise<Instructions | undefined>>();
  const scannedDirs = new Set<string>();

  // Directories strictly between the launch dir and `dir`, nearest first. Empty when `dir` is outside the launch dir.
  const between = (dir: string): string[] => {
    const rel = relative(cwd, dir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
    const dirs: string[] = [];
    for (let d = dir; d !== cwd; d = dirname(d)) dirs.push(d);
    return dirs;
  };

  const nearest = async (dirs: string[]): Promise<Instructions | undefined> => {
    for (const dir of dirs) {
      if (!byDir.has(dir)) byDir.set(dir, firstExisting(NAMES.map((n) => join(dir, n))));
      const found = await byDir.get(dir);
      if (found) return found;
    }
  };

  hooks.on("PostToolUse", async (e) => {
    if (!e.ok) return;
    await ready;
    const input = e.input as { path?: unknown };
    const touched = e.changes
      ? e.changes.flatMap((c) => (c.moveTo ? [c.path, c.moveTo] : [c.path]))
      : typeof input?.path === "string"
        ? [input.path]
        : [];

    const added: string[] = [];
    for (const p of touched) {
      const abs = resolve(cwd, p);
      const self = await realpath(abs).catch(() => abs);
      const dirs = between(dirname(abs));

      const found = await nearest(dirs);
      const real = found && (await realpath(found.path).catch(() => found.path));
      // Skip files already in context, including the instruction file the model just read itself.
      if (found && real && !seen.has(real)) {
        seen.add(real);
        if (real !== self) {
          const rel = relative(cwd, found.path);
          onLoad?.(rel);
          added.push(`<instructions path="${rel}">\nInstructions for files under ${dirname(rel)}/. Follow them there.\n\n${found.text}\n</instructions>`);
        }
      }

      for (const dir of dirs) {
        if (scannedDirs.has(dir)) continue;
        scannedDirs.add(dir);
        const fresh: Skill[] = [];
        for (const skill of await scanSkills(SKILL_DIRS.map((d) => join(dir, d)), cwd)) {
          const r = await realpath(resolve(cwd, skill.path)).catch(() => skill.path);
          if (!seen.has(r)) {
            seen.add(r);
            fresh.push(skill);
          }
        }
        if (!fresh.length) continue;
        const rel = relative(cwd, dir);
        onLoad?.(`${fresh.length} skill${fresh.length > 1 ? "s" : ""} from ${rel}`);
        added.push(
          `<skills path="${rel}">\nMore skills for work under ${rel}/. Same rules as the skills in the system prompt.\n${formatSkills(fresh)}\n</skills>`,
        );
      }
    }
    if (added.length) return { context: added.join("\n\n") };
  });
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  // Local dirs first, so a project skill wins over a global one with the same name.
  return scanSkills([...SKILL_DIRS.map((d) => join(cwd, d)), ...GLOBAL_SKILL_DIRS], cwd);
}

export function formatSkills(skills: Skill[]): string {
  return skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`).join("\n");
}

// Reads SKILL.md headers from each root in order. The first skill with a given name wins.
async function scanSkills(roots: string[], cwd: string): Promise<Skill[]> {
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
