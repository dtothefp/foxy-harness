import { resolve } from "node:path";
import { ATTACHABLE, DOCUMENT_FILE, extractText, findFile, loadAttachment } from "../attachments.ts";
import type { Tool } from "./types.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a file. Text comes back as lines prefixed with line numbers (`  12→text`). " +
      "Images (png, jpg, gif, webp, heic) and PDFs are attached so you can see them. " +
      "Word, RTF, ODT, Excel (xlsx) and PowerPoint (pptx) files are converted to text. " +
      `Reads up to ${DEFAULT_LIMIT} lines; use offset/limit for longer files. Paths are relative to the working directory.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        offset: { type: "number", description: "1-based line to start from (default 1)" },
        limit: { type: "number", description: `Max lines to return (default ${DEFAULT_LIMIT})` },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  hint: "read files with line numbers. Also views images and PDFs, and reads Word, Excel and PowerPoint as text. Prefer it over cat, head or sed.",

  async run(input, { cwd }) {
    const { path, offset = 1, limit = DEFAULT_LIMIT } = input as { path?: unknown; offset?: number; limit?: number };
    if (typeof path !== "string") return { output: "Invalid arguments: `path` must be a string.", ok: false };

    const found = await findFile(resolve(cwd, path));
    if (!found) return { output: `No such file: ${path}`, ok: false };
    let text: string;
    try {
      if (ATTACHABLE.test(found)) {
        const a = await loadAttachment(found);
        return { output: `Attached ${path}${a.pages ? ` (${a.pages} page${a.pages === 1 ? "" : "s"})` : ""}.`, ok: true, attachments: [a] };
      }
      text = DOCUMENT_FILE.test(found) ? extractText(found) : await Bun.file(found).text();
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), ok: false };
    }
    // NUL bytes mean binary. Don't hand the model a page of mojibake.
    if (text.slice(0, 8000).includes("\0")) return { output: `${path} is a binary file and can't be read as text.`, ok: false };

    const lines = text.split("\n");
    const start = Math.max(1, Math.floor(offset));
    const slice = lines.slice(start - 1, start - 1 + Math.max(1, Math.floor(limit)));
    const width = String(start + slice.length - 1).length;
    let output = slice
      .map((line, i) => {
        const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line truncated]` : line;
        return `${String(start + i).padStart(width + 2)}→${text}`;
      })
      .join("\n");

    const end = start + slice.length - 1;
    if (end < lines.length) output += `\n\n[showing lines ${start}-${end} of ${lines.length}; use offset to read more]`;
    return { output, ok: true };
  },
};
