// Streaming Markdown for the terminal. Deltas are held until a newline, then each finished line
// is styled and written. Tables are held until they end so the columns can line up.
// Covers what models actually write: headings, bold/italic, inline code, fences, lists, quotes, links, tables.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const CODE = "\x1b[36m";
const HEADING = "\x1b[1;35m";
const ANSI = /\x1b\[[0-9;]*m/g;
// Inline styles close with their own off codes, so bold inside a heading keeps the heading color.
const BOLD_OFF = "\x1b[22m";
const ITALIC_OFF = "\x1b[23m";
const UNDERLINE_OFF = "\x1b[24m";
const FG_OFF = "\x1b[39m";

export function markdownStream(write: (s: string) => void) {
  let buf = "";
  let fence: string | undefined;
  let table: string[] = [];

  function line(raw: string) {
    const open = raw.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fence) {
      // Only a bare fence at least as long closes, so a ```bash line inside a ```markdown block stays code.
      if (open && !open[2] && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = undefined;
      else write(`${DIM}│${RESET} ${CODE}${raw}${RESET}\n`);
      return;
    }
    if (open) {
      fence = open[1];
      if (open[2]) write(`${DIM}${open[2]}${RESET}\n`);
      return;
    }
    if (/^\s*\|/.test(raw)) return void table.push(raw);
    flushTable();
    write(`${block(raw)}\n`);
  }

  function flushTable() {
    if (!table.length) return;
    write(renderTable(table));
    table = [];
  }

  return {
    push(delta: string) {
      buf += delta;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    // Call when the model stops talking (a tool call or the end of a step).
    end() {
      if (buf) line(buf);
      flushTable();
      buf = "";
      fence = undefined;
    },
  };
}

function block(raw: string): string {
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
    const text = inline(m[2]!.replace(/\*\*/g, "")); // headings are bold already
    return m[1]!.length <= 2 ? `${HEADING}${UNDERLINE}${text}${RESET}` : `${HEADING}${text}${RESET}`;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return `${DIM}${"─".repeat(Math.min(process.stdout.columns || 80, 60))}${RESET}`;
  if ((m = raw.match(/^\s*>\s?(.*)/))) return `${DIM}│${RESET} ${ITALIC}${inline(m[1]!)}${RESET}`;
  if ((m = raw.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)/))) return `${m[1]}${m[2] === " " ? "☐" : "☑"} ${inline(m[3]!)}`;
  if ((m = raw.match(/^(\s*)[-*+]\s+(.*)/))) return `${m[1]}${DIM}•${RESET} ${inline(m[2]!)}`;
  if ((m = raw.match(/^(\s*)(\d+[.)])\s+(.*)/))) return `${m[1]}${DIM}${m[2]}${RESET} ${inline(m[3]!)}`;
  return inline(raw);
}

// Code spans first, so nothing inside backticks gets styled. Underscore italics are skipped
// on purpose, they'd mangle snake_case identifiers.
export function inline(s: string): string {
  return s
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2) return `${CODE}${part.slice(1, -1)}${FG_OFF}`;
      return part
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/(^|[^*\w])\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
        .replace(/~~(.+?)~~/g, `${DIM}$1${BOLD_OFF}`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) =>
          text === url ? `${UNDERLINE}${url}${UNDERLINE_OFF}` : `${UNDERLINE}${text}${UNDERLINE_OFF} ${DIM}(${url})${BOLD_OFF}`,
        );
    })
    .join("");
}

function renderTable(rows: string[]): string {
  const cells = rows.map((r) =>
    r
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim()),
  );
  const isRule = (row: string[]) => row.every((c) => /^:?-+:?$/.test(c));
  const body = cells.filter((row) => !isRule(row)).map((row, i) => row.map((c) => (i === 0 ? `${BOLD}${inline(c)}${RESET}` : inline(c))));
  const cols = Math.max(...body.map((r) => r.length));
  const width = (s: string) => s.replace(ANSI, "").length;
  const widths = Array.from({ length: cols }, (_, j) => Math.max(...body.map((r) => width(r[j] ?? ""))));
  const sep = `${DIM}│${RESET}`;
  const out = body.map((row) => widths.map((w, j) => (row[j] ?? "") + " ".repeat(w - width(row[j] ?? ""))).join(` ${sep} `));
  if (out.length > 1) out.splice(1, 0, `${DIM}${widths.map((w) => "─".repeat(w)).join("─┼─")}${RESET}`);
  return out.map((l) => `${l}\n`).join("");
}
