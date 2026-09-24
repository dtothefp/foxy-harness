import { diffLines, hunks, type DiffLine } from "./diff.ts";
import type { FileChange } from "./tools/types.ts";

// GitHub-style red/green diff for the terminal. Truecolor backgrounds, full-width rows.

const RESET = "\x1b[0m";
const FG_RESET = "\x1b[39m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const DEL_BG = "\x1b[48;2;75;22;26m";
const ADD_BG = "\x1b[48;2;20;58;34m";
const DEL_FG = "\x1b[38;2;255;130;130m";
const ADD_FG = "\x1b[38;2;120;230;140m";
const MAX_LINES = 150;
const INDENT = "  ";

export function renderChanges(changes: FileChange[], width = process.stdout.columns || 100): string {
  return changes.map((c) => renderChange(c, width - INDENT.length)).join("\n");
}

function renderChange(c: FileChange, width: number): string {
  const lines = diffLines(c.before, c.after);
  const adds = lines.filter((l) => l.op === "+").length;
  const dels = lines.filter((l) => l.op === "-").length;
  const verb = c.kind === "add" ? "Create" : c.kind === "delete" ? "Delete" : c.moveTo ? "Move" : "Update";
  const target = c.moveTo ? `${c.path} → ${c.moveTo}` : c.path;
  const out = [`${BOLD}⏺ ${verb}(${target})${RESET} ${ADD_FG}+${adds}${RESET} ${DEL_FG}-${dels}${RESET}`];
  if (c.kind === "delete") return out[0]!;

  const numWidth = String(Math.max(lines.at(-1)?.oldNo ?? 0, lines.at(-1)?.newNo ?? 0)).length;
  let shown = 0;
  let total = 0;
  hunks(lines).forEach((hunk, k) => {
    total += hunk.length;
    if (shown >= MAX_LINES) return;
    if (k > 0) out.push(`${INDENT}${DIM}${" ".repeat(numWidth)} ⋮${RESET}`);
    for (const l of hunk) {
      if (shown++ >= MAX_LINES) break;
      out.push(INDENT + formatLine(l, numWidth, width));
    }
  });
  if (total > MAX_LINES) out.push(`${INDENT}${DIM}… ${total - MAX_LINES} more diff lines${RESET}`);
  return out.join("\n");
}

function formatLine(l: DiffLine, numWidth: number, width: number): string {
  const no = String(l.op === "+" ? l.newNo : l.oldNo).padStart(numWidth);
  let text = l.text.replace(/\t/g, "  ");
  const room = width - numWidth - 3;
  text = text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text.padEnd(room);
  if (l.op === " ") return `${DIM}${no}   ${text.trimEnd()}${RESET}`;
  const [bg, fg] = l.op === "+" ? [ADD_BG, ADD_FG] : [DEL_BG, DEL_FG];
  return `${bg}${DIM}${no}${RESET}${bg} ${fg}${l.op}${FG_RESET} ${text}${RESET}`;
}
