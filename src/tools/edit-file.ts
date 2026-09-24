import { resolve } from "node:path";
import { relPath } from "./changes.ts";
import type { EditTool } from "./types.ts";

// Exact string replacement, the edit shape Claude is trained on (same as Claude Code's Edit tool).

export const editFileTool: EditTool = {
  spec: {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string. old_string must match the file exactly, including whitespace and indentation, " +
      "and must be unique unless replace_all is true (include surrounding lines to make it unique). " +
      "To create a file, pass an empty old_string and the full contents as new_string. Read a file before editing it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        old_string: { type: "string", description: "Exact text to replace. Empty to create a new file." },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  hint: "all file edits and new files. Never edit files with sed, heredocs or scripts.",

  async plan(input, { cwd }) {
    const { path, old_string: oldStr, new_string: newStr, replace_all: all } = input;
    if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") {
      throw new Error("Invalid arguments: path, old_string and new_string must be strings.");
    }
    const rel = relPath(cwd, path);
    const file = Bun.file(resolve(cwd, rel));
    const exists = await file.exists();
    const before = exists ? await file.text() : "";

    if (oldStr === "") {
      if (before) throw new Error(`${path} already exists. Pass a non-empty old_string to edit it.`);
      return [{ path: rel, kind: exists ? "update" : "add", before, after: newStr }];
    }
    if (!exists) throw new Error(`No such file: ${path}`);
    if (oldStr === newStr) throw new Error("old_string and new_string are identical.");

    const count = before.split(oldStr).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${path}. It must match exactly, including whitespace. Re-read the file.`);
    }
    if (count > 1 && all !== true) {
      throw new Error(`old_string matches ${count} places in ${path}. Add surrounding lines to make it unique, or set replace_all.`);
    }
    const after = all === true ? before.split(oldStr).join(newStr) : before.replace(oldStr, () => newStr);
    return [{ path: rel, kind: "update", before, after }];
  },
};
