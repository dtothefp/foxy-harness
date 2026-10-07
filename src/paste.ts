import { ATTACHABLE, PDF_FILE } from "./attachments.ts";

// Big pastes and dragged-in files show as a short placeholder in the input, like Claude Code does:
// [Pasted text #1 +42 lines], [Image #1]. The real text goes back in when the prompt is sent.

const PATH = /'([^']+)'|"([^"]+)"|((?:~|\.{0,2}\/)(?:\\.|\S)+)/g;
// Shorter pastes than this go in as typed.
const MAX_LINES = 3;
const MAX_CHARS = 500;

export function createPastes() {
  const held = new Map<string, string>();
  let texts = 0;
  let files = 0;

  return {
    // What the input shows for a paste. Placeholders, or the text itself when it's short.
    label(text: string): string {
      const paths = filePaths(text);
      if (paths) {
        return paths
          .map((path) => {
            const tag = `[${PDF_FILE.test(unquote(path)) ? "PDF" : "Image"} #${++files}]`;
            held.set(tag, path);
            return tag;
          })
          .join(" ");
      }
      const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").length;
      if (lines <= MAX_LINES && text.length <= MAX_CHARS) return text;
      const tag = `[Pasted text #${++texts} ${lines > 1 ? `+${lines} lines` : `${text.length} chars`}]`;
      held.set(tag, text.replace(/\r\n?/g, "\n"));
      return tag;
    },
    // The prompt with every placeholder still in it swapped for what was pasted.
    expand(prompt: string): string {
      let out = prompt;
      for (const [tag, text] of held) out = out.split(tag).join(text);
      return out;
    },
    // After a prompt is sent. Numbering starts over, like a new message in Claude Code.
    clear() {
      held.clear();
      texts = 0;
      files = 0;
    },
  };
}

// The paths in a paste that's nothing but image or PDF paths, as Finder drops them. Otherwise undefined.
function filePaths(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return undefined;
  const paths = [...trimmed.matchAll(PATH)].map((m) => m[0]);
  if (!paths.length || trimmed.replace(PATH, "").trim()) return undefined;
  return paths.every((p) => ATTACHABLE.test(unquote(p))) ? paths : undefined;
}

const unquote = (p: string) => p.replace(/^['"]|['"]$/g, "").replace(/\\(.)/g, "$1");
