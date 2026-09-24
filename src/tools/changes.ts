import { mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { FileChange } from "./types.ts";

// Paths are stored relative to cwd so diffs and results read cleanly.
export function relPath(cwd: string, path: string): string {
  return relative(cwd, resolve(cwd, path)) || path;
}

// Writes planned changes to disk. Returns the result the model sees, in Codex's format.
export async function applyChanges(changes: FileChange[], cwd: string): Promise<string> {
  const lines: string[] = [];
  for (const c of changes) {
    const from = resolve(cwd, c.path);
    if (c.kind === "delete") {
      await rm(from);
      lines.push(`D ${c.path}`);
      continue;
    }
    const to = resolve(cwd, c.moveTo ?? c.path);
    await mkdir(dirname(to), { recursive: true });
    await Bun.write(to, c.after);
    if (to !== from) await rm(from);
    lines.push(`${c.kind === "add" ? "A" : "M"} ${c.moveTo ?? c.path}`);
  }
  return `Success. Updated the following files:\n${lines.join("\n")}`;
}
