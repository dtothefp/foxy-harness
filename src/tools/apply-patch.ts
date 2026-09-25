import { resolve } from "node:path";
import { relPath } from "./changes.ts";
import type { EditTool, FileChange } from "./types.ts";

// Codex's patch format, which GPT-5 / Codex models are trained on. Ported from
// codex-rs/apply-patch. No line numbers: each change is located by its context lines.

const DESCRIPTION = `Create, edit, rename and delete files by applying a patch. The whole patch applies or none of it does.

*** Begin Patch
*** Add File: path/to/new.ts
+every line of the new file, prefixed with +
*** Update File: path/to/existing.ts
*** Move to: path/to/renamed.ts        (optional)
@@ a line from the enclosing function or class (optional, disambiguates)
 unchanged context line (leading space)
-line to remove
+line to add
 unchanged context line
*** Delete File: path/to/old.ts
*** End Patch

No line numbers. Give about 3 unchanged lines above and below each change, and start each separate change in a file with its own @@ line. Paths are relative to the working directory.`;

export const applyPatchTool: EditTool = {
  spec: {
    name: "apply_patch",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The full patch, from *** Begin Patch to *** End Patch" },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
  hint: "all file edits, new files, renames and deletes. Never edit files with sed, heredocs or scripts.",

  async plan(input, { cwd }) {
    if (typeof input.input !== "string") throw new Error("Invalid arguments: `input` must be the patch text.");
    const changes: FileChange[] = [];
    for (const op of parsePatch(input.input)) {
      const path = relPath(cwd, op.path);
      const file = Bun.file(resolve(cwd, path));
      const exists = await file.exists();
      const before = exists ? await file.text() : "";

      if (op.kind === "add") {
        const after = op.lines.length ? `${op.lines.join("\n")}\n` : "";
        changes.push({ path, kind: exists ? "update" : "add", before, after });
        continue;
      }
      if (!exists) throw new Error(`File not found: ${op.path}`);
      if (op.kind === "delete") {
        changes.push({ path, kind: "delete", before, after: "" });
      } else {
        const after = applyChunks(before, op.chunks, op.path);
        changes.push({ path, kind: "update", before, after, moveTo: op.moveTo && relPath(cwd, op.moveTo) });
      }
    }
    return changes;
  },
};

type Chunk = { anchor?: string; old: string[]; new: string[]; eof: boolean };
type Op =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: Chunk[] };

export function parsePatch(text: string): Op[] {
  let lines = text
    .trim()
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  // Models sometimes wrap the patch in a shell heredoc. Unwrap it.
  if (/<<\s*['"]?EOF['"]?\s*$/.test(lines[0] ?? "") && lines.at(-1)?.trim() === "EOF") lines = lines.slice(1, -1);
  if (lines[0]?.trim() !== "*** Begin Patch") throw new Error("Invalid patch: the first line must be '*** Begin Patch'.");
  if (lines.at(-1)?.trim() !== "*** End Patch") throw new Error("Invalid patch: the last line must be '*** End Patch'.");

  const ops: Op[] = [];
  const end = lines.length - 1;
  let i = 1;
  const header = (prefix: string) => (lines[i]!.startsWith(prefix) ? lines[i]!.slice(prefix.length).trim() : undefined);

  while (i < end) {
    let path: string | undefined;
    if ((path = header("*** Add File: "))) {
      i++;
      const body: string[] = [];
      while (i < end && lines[i]!.startsWith("+")) body.push(lines[i++]!.slice(1));
      ops.push({ kind: "add", path, lines: body });
    } else if ((path = header("*** Delete File: "))) {
      i++;
      ops.push({ kind: "delete", path });
    } else if ((path = header("*** Update File: "))) {
      i++;
      let moveTo: string | undefined;
      if ((moveTo = header("*** Move to: "))) i++;
      const chunks: Chunk[] = [];
      let chunk: Chunk | undefined;
      while (i < end && (!lines[i]!.startsWith("*** ") || lines[i] === "*** End of File")) {
        const line = lines[i++]!;
        if (line.startsWith("@@")) {
          chunks.push((chunk = { anchor: line.slice(2).trim() || undefined, old: [], new: [], eof: false }));
          continue;
        }
        if (!chunk) chunks.push((chunk = { old: [], new: [], eof: false }));
        if (line === "*** End of File") chunk.eof = true;
        else if (line === "" || line.startsWith(" ")) {
          chunk.old.push(line.slice(1));
          chunk.new.push(line.slice(1));
        } else if (line.startsWith("-")) chunk.old.push(line.slice(1));
        else if (line.startsWith("+")) chunk.new.push(line.slice(1));
        else {
          throw new Error(
            `Invalid patch line in ${path}: ${JSON.stringify(line)}. Every line in an update must start with ' ', '-' or '+'.`,
          );
        }
      }
      const real = chunks.filter((c) => c.old.length || c.new.length);
      if (!real.length) throw new Error(`Invalid patch: '*** Update File: ${path}' has no changes.`);
      ops.push({ kind: "update", path, moveTo, chunks: real });
    } else if (lines[i]!.trim() === "") {
      i++;
    } else {
      throw new Error(`Invalid patch: unexpected line ${JSON.stringify(lines[i])}.`);
    }
  }
  if (!ops.length) throw new Error("Invalid patch: no file operations.");
  return ops;
}

function applyChunks(content: string, chunks: Chunk[], path: string): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const edits: { at: number; remove: number; insert: string[] }[] = [];
  let from = 0;
  for (const c of chunks) {
    if (c.anchor) {
      const at = seek(lines, [c.anchor], from, false) ?? lines.findIndex((l, k) => k >= from && l.includes(c.anchor!));
      if (at < 0) throw new Error(`Failed to find '@@ ${c.anchor}' in ${path}.`);
      from = at + 1;
    }
    // Pure addition with no context: append to the end of the file.
    if (!c.old.length) {
      edits.push({ at: lines.length, remove: 0, insert: c.new });
      continue;
    }
    let { old, new: insert } = c;
    let at = seek(lines, old, from, c.eof);
    // A trailing blank context line often doesn't exist in the file. Retry without it.
    if (at === undefined && old.at(-1) === "") {
      old = old.slice(0, -1);
      if (insert.at(-1) === "") insert = insert.slice(0, -1);
      at = seek(lines, old, from, c.eof);
    }
    if (at === undefined) {
      throw new Error(`Failed to find these lines in ${path} (re-read the file and retry):\n${c.old.join("\n")}`);
    }
    edits.push({ at, remove: old.length, insert });
    from = at + old.length;
  }

  for (const e of edits.sort((x, y) => y.at - x.at)) lines.splice(e.at, e.remove, ...e.insert);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

// Finds `pattern` in `lines`, from strictest to loosest match. Same ladder as Codex.
const LOOSENESS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) =>
    s
      .trim()
      .replace(/[‐-―−]/g, "-")
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/ /g, " "),
];

function seek(lines: string[], pattern: string[], from: number, eof: boolean): number | undefined {
  const last = lines.length - pattern.length;
  for (const norm of LOOSENESS) {
    const p = pattern.map(norm);
    const matches = (i: number) => p.every((line, k) => norm(lines[i + k]!) === line);
    if (eof && last >= from && matches(last)) return last;
    for (let i = from; i <= last; i++) if (matches(i)) return i;
  }
}
