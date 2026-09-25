import { format } from "node:util";

// The full-screen view, like Claude Code's. Output fills the screen above a panel pinned to the bottom
// (a status line, the input, and a line of hints). It runs on the terminal's alternate screen and keeps
// its own transcript, so the panel stays put while you scroll back with the mouse wheel or PgUp/PgDn.
// Leaving it prints the transcript to the normal screen, so it ends up in the terminal's scrollback.
//
// Everything written to stdout goes into the transcript. Readline does the line editing with its echo
// muted, and the input is drawn here from its state.
//
// It also sets the terminal title the way Claude Code does, which is how session managers (Orca, tmux
// pane titles in Agent of Empires) tell whether an agent is busy. A braille spinner frame while working,
// ✋ while a permission question waits, ✳ when idle at the prompt.

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
// Synchronized output, so a redraw doesn't flicker in terminals that support it.
const BEGIN = "\x1b[?2026h\x1b[?25l";
const END = "\x1b[?25h\x1b[?2026l";
// Alternate screen, plus mouse button reports in SGR format for the wheel.
const ENTER = "\x1b[?1049h\x1b[?1000h\x1b[?1006h";
const LEAVE = "\x1b[?1006l\x1b[?1000l\x1b[?1049l";
const at = (row: number, col = 1) => `\x1b[${row};${col}H`;
const TOKENS = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
const SGR = /^\x1b\[[0-9;]*m$/;
// Older lines are dropped past this.
const MAX_LINES = 20000;

export type InputView = {
  // Every line of the input, the one being edited last.
  lines: string[];
  // Where the cursor is in the last line.
  cursor: number;
  // Replaces the › prompt, for a question like "apply? [Y/n/reason]".
  label?: string;
  hint: string;
};

export function createTui(view: () => InputView, out: NodeJS.WriteStream = process.stdout) {
  const original = out.write.bind(out) as (...args: unknown[]) => boolean;
  const raw = (s: string) => original(s);
  let active = false;
  let label: string | undefined;
  let waiting = false;
  let started = 0;
  let frame = 0;

  // The transcript, one entry per line. The last one is still being written.
  const lines: string[] = [""];
  // Completed lines wrapped to the screen width, and how many rows each took.
  let rows: string[] = [];
  let counts: number[] = [];
  let wrappedAt = 0;
  // The line of the latest prompt. It's kept at the top of the screen until the reply fills it.
  let anchor = -1;
  // Rows scrolled back from the bottom. 0 follows new output.
  let scroll = 0;
  let lastTop = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  // Where the cursor goes in the panel, relative to its top.
  let caret = { row: 0, col: 0 };

  const height = () => out.rows || 24;
  const width = () => out.columns || 80;
  const elapsed = () => Math.round((performance.now() - started) / 1000);
  const title = (glyph: string) => out.isTTY && raw(`\x1b]0;${glyph} foxy-harness\x07`);

  function append(s: string) {
    const parts = s.replace(/\r\n/g, "\n").split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        const done = lines[lines.length - 1]!;
        const wrapped = wrap(done, width());
        rows.push(...wrapped);
        counts.push(wrapped.length);
        lines.push("");
      }
      // A carriage return starts the line over.
      const cr = part.lastIndexOf("\r");
      lines[lines.length - 1] = cr >= 0 ? part.slice(cr + 1) : lines[lines.length - 1] + part;
    });
    if (lines.length > MAX_LINES) {
      const drop = lines.length - MAX_LINES;
      lines.splice(0, drop);
      rows.splice(
        0,
        counts.splice(0, drop).reduce((a, b) => a + b, 0),
      );
      anchor -= drop;
    }
  }

  // All rows at the current width, with the line still being written at the end.
  function allRows(): { rows: string[]; anchorRow: number } {
    if (wrappedAt !== width()) {
      wrappedAt = width();
      rows = [];
      counts = [];
      for (const line of lines.slice(0, -1)) {
        const wrapped = wrap(line, wrappedAt);
        rows.push(...wrapped);
        counts.push(wrapped.length);
      }
    }
    const last = lines[lines.length - 1]!;
    const anchorRow = anchor < 0 ? -1 : counts.slice(0, anchor).reduce((a, b) => a + b, 0);
    return { rows: last ? [...rows, ...wrap(last, wrappedAt)] : rows, anchorRow };
  }

  function status(): string {
    if (label) return `\x1b[36m${FRAMES[frame % FRAMES.length]}\x1b[0m \x1b[2m${label}… ${elapsed()}s\x1b[0m`;
    if (waiting) return "✋ \x1b[2mWaiting for your answer\x1b[0m";
    return "";
  }

  function panel(): string[] {
    const w = width();
    const v = view();
    const prompt = v.label ? `\x1b[2m${v.label}\x1b[0m` : "\x1b[36m›\x1b[0m ";
    const indent = Bun.stringWidth(prompt);
    const room = Math.max(10, w - indent - 1);
    const input: string[] = [];
    v.lines.forEach((line, i) => {
      const wrapped = chunk(line, room);
      if (i === v.lines.length - 1) {
        // The cursor may sit just past a full row.
        const before = Bun.stringWidth(line.slice(0, v.cursor));
        const r = Math.floor(before / room);
        if (r >= wrapped.length) wrapped.push("");
        caret = { row: input.length + r, col: indent + before - r * room };
      }
      for (const text of wrapped) input.push(`${input.length ? " ".repeat(indent) : prompt}${text}`);
    });
    // Long input shows the rows around the cursor.
    const max = Math.max(1, Math.floor(height() / 3));
    const first = Math.max(0, Math.min(caret.row - max + 1, input.length - max));
    caret = { row: caret.row - first + 2, col: caret.col };
    const rule = `\x1b[2m${"─".repeat(w)}\x1b[0m`;
    const hint = scroll ? "scrolled back · PgDn or the wheel to return" : v.hint;
    return [status(), rule, ...input.slice(first, first + max), rule, `\x1b[2m${hint}\x1b[0m`];
  }

  function draw() {
    pending = undefined;
    if (!active) return;
    const bottom = panel();
    const size = Math.max(1, height() - bottom.length);
    const { rows: all, anchorRow } = allRows();
    // Following, the latest prompt stays at the top until its reply fills the screen.
    const follow = Math.max(0, all.length - size, anchorRow);
    // Scrolled back, new output doesn't move what you're reading.
    if (scroll) scroll += follow - lastTop;
    scroll = Math.max(0, Math.min(scroll, follow));
    lastTop = follow;
    const top = follow - scroll;
    let seq = BEGIN;
    for (let r = 0; r < size; r++) seq += `${at(r + 1)}\x1b[2K${all[top + r] ?? ""}`;
    bottom.forEach((line, i) => (seq += `${at(size + 1 + i)}\x1b[2K${cut(line, width())}`));
    raw(`${seq}${at(size + 1 + caret.row, caret.col + 1)}${END}`);
  }

  // Output can arrive a token at a time. Draw at most once a frame.
  const schedule = () => void (pending ??= setTimeout(draw, 16));

  if (out.isTTY) {
    out.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (!active) return original(chunk, ...rest);
      append(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      schedule();
      const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      done?.();
      return true;
    }) as typeof out.write;
    // Bun's console.log writes to the fd directly, not through stdout.write. Send it through. Errors too
    // while the view is up, or they'd print over it.
    console.log = (...args: unknown[]) => void out.write(`${format(...args)}\n`);
    const error = console.error.bind(console);
    console.error = (...args: unknown[]) => (active ? void out.write(`${format(...args)}\n`) : error(...args));
    setInterval(() => {
      if (!active || !label) return;
      frame++;
      draw();
    }, 100).unref();
    out.on("resize", () => draw());
    process.on("exit", () => {
      stop();
      raw("\x1b]0;\x07");
    });
  }

  const panelSize = () => panel().length;

  function stop() {
    if (!active) return;
    active = false;
    if (pending) clearTimeout(pending);
    // Back on the normal screen, the transcript goes into the terminal's own scrollback.
    raw(LEAVE);
    const text = lines.join("\n");
    raw(text.endsWith("\n") || !text ? text : `${text}\n`);
  }

  return {
    start() {
      if (!out.isTTY || active) return;
      active = true;
      raw(`${ENTER}\x1b[2J`);
      draw();
    },
    stop,
    render: draw,
    // Scrolls back (positive) or forward, in rows. PgUp/PgDn and the wheel.
    scroll(by: number) {
      scroll = Math.max(0, scroll + (by === Infinity ? height() : by === -Infinity ? -scroll : by));
      draw();
    },
    page: () => Math.max(1, height() - panelSize() - 2),
    // A new prompt starts at the top of the screen.
    toTop() {
      if (!active) return;
      if (lines[lines.length - 1]) out.write("\n");
      anchor = lines.length - 1;
      scroll = 0;
    },
    busy(text: string) {
      label = text;
      waiting = false;
      started = performance.now();
      title(FRAMES[0]!);
      draw();
    },
    // Returns the seconds since busy(), for messages like "compacted in 12s".
    idle() {
      const secs = elapsed();
      label = undefined;
      waiting = false;
      title("✳");
      draw();
      return secs;
    },
    // Waiting on the user mid-turn, like a permission question.
    waiting() {
      label = undefined;
      waiting = true;
      title("✋");
      draw();
    },
  };
}

// Splits plain text into rows of at most `room` columns.
function chunk(text: string, room: number): string[] {
  const rows = [""];
  let used = 0;
  for (const ch of text) {
    const w = Bun.stringWidth(ch);
    if (used + w > room) {
      rows.push("");
      used = 0;
    }
    rows[rows.length - 1] += ch;
    used += w;
  }
  return rows;
}

// Wraps a styled line to `w` columns. Each row restarts the styles in effect, so rows draw on their own.
function wrap(line: string, w: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  let style = "";
  for (const part of line.split(TOKENS)) {
    if (!part) continue;
    if (part[0] === "\x1b") {
      // Only colors and styles. Anything that moves the cursor would break the layout.
      if (!SGR.test(part)) continue;
      style = /^\x1b\[0?m$/.test(part) ? "" : style + part;
      row += part;
      continue;
    }
    for (const ch of part.replace(/\t/g, "    ")) {
      const cw = Bun.stringWidth(ch);
      if (used + cw > w) {
        rows.push(`${row}\x1b[0m`);
        row = style;
        used = 0;
      }
      row += ch;
      used += cw;
    }
  }
  rows.push(`${row}\x1b[0m`);
  return rows;
}

// Cuts a styled line to fit in `w` columns, one short so it never wraps.
function cut(line: string, w: number): string {
  if (Bun.stringWidth(line) < w) return line;
  let out = "";
  let used = 0;
  for (const part of line.split(TOKENS)) {
    if (!part) continue;
    if (part[0] === "\x1b") {
      out += part;
      continue;
    }
    for (const ch of part) {
      const cw = Bun.stringWidth(ch);
      if (used + cw >= w) return `${out}\x1b[0m`;
      out += ch;
      used += cw;
    }
  }
  return out;
}
