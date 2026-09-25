import { format } from "node:util";

// The full-screen view, like Claude Code's. Output fills the screen above a panel pinned to the bottom
// (a status line, the input, and a line of hints). It runs on the terminal's alternate screen and keeps
// its own transcript, so the panel stays put while you scroll back with the mouse wheel or PgUp/PgDn.
// Leaving it prints the transcript to the normal screen, so it ends up in the terminal's scrollback.
//
// Asking for the wheel means the terminal sends drags here too instead of selecting text, so selection is
// drawn here as well, like Claude Code does. Drag to select, double-click for a word. Letting go copies it.
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
// Alternate screen, plus mouse reports in SGR format for the wheel and for selecting (1002 adds drags).
const ENTER = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const LEAVE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l";
const at = (row: number, col = 1) => `\x1b[${row};${col}H`;
const TOKENS = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
const SGR = /^\x1b\[[0-9;]*m$/;
// Older lines are dropped past this.
const MAX_LINES = 20000;
// Two clicks this close together select a word.
const DOUBLE_CLICK_MS = 400;

// A cell in the transcript. Row counts wrapped rows from the top of the transcript, col from 0.
type Cell = { row: number; col: number };
export type Mouse = { button: number; x: number; y: number; release: boolean };

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
  // The selection, from where the drag started to where it is now.
  let from: Cell | undefined;
  let to: Cell | undefined;
  let dragging = false;
  let lastClick = { at: 0, row: -1, col: -1 };
  // A short note in the hint line, like "Copied".
  let flash = "";
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let viewSize = 0;

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
      clearSelection();
    }
  }

  // All rows at the current width, with the line still being written at the end.
  function allRows(): { rows: string[]; anchorRow: number } {
    if (wrappedAt !== width()) {
      wrappedAt = width();
      clearSelection();
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
    const hint = flash || (scroll ? "scrolled back · PgDn or the wheel to return" : v.hint);
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
    viewSize = size;
    const sel = ordered();
    let seq = BEGIN;
    for (let r = 0; r < size; r++) {
      const i = top + r;
      let row = all[i] ?? "";
      if (sel && i >= sel[0].row && i <= sel[1].row) {
        row = highlight(row, i === sel[0].row ? sel[0].col : 0, i === sel[1].row ? sel[1].col : Infinity);
      }
      seq += `${at(r + 1)}\x1b[2K${row}`;
    }
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

  function clearSelection() {
    from = to = undefined;
    dragging = false;
  }

  // The selection with its start first, or nothing if there isn't one.
  function ordered(): [Cell, Cell] | undefined {
    if (!from || !to) return undefined;
    return from.row < to.row || (from.row === to.row && from.col <= to.col) ? [from, to] : [to, from];
  }

  function note(text: string) {
    flash = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ((flash = ""), draw()), 1500);
    flashTimer.unref?.();
  }

  // The selected text. Rows wrapped from one line join back up, and each line loses its trailing spaces.
  function selectedText(): string {
    const sel = ordered();
    if (!sel) return "";
    const { rows: all } = allRows();
    // Which rows start a line, so wrapped ones join without a newline.
    const starts = new Set<number>();
    let n = 0;
    for (const c of counts) {
      starts.add(n);
      n += c;
    }
    starts.add(n);
    let text = "";
    for (let i = sel[0].row; i <= sel[1].row; i++) {
      if (i > sel[0].row && starts.has(i)) text = `${text.trimEnd()}\n`;
      text += cols(plain(all[i] ?? ""), i === sel[0].row ? sel[0].col : 0, i === sel[1].row ? sel[1].col : Infinity);
    }
    return text
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  }

  function copySelection() {
    const text = selectedText();
    if (!text.trim()) return clearSelection();
    copy(text, raw);
    note(`Copied ${text.length} characters`);
  }

  function mouse(e: Mouse) {
    // Modifier bits (shift 4, alt 8, ctrl 16) don't change what a button does here.
    const button = e.button & ~28;
    if (button === 64) return tui.scroll(3);
    if (button === 65) return tui.scroll(-3);
    // Clicks on the panel aren't for the transcript.
    const inView = e.y <= viewSize;
    const { rows: all } = allRows();
    const top = lastTop - scroll;
    const cell = { row: top + Math.min(e.y, viewSize) - 1, col: e.x - 1 };
    if (button === 0 && !e.release) {
      if (!inView) return;
      const now = performance.now();
      const double = now - lastClick.at < DOUBLE_CLICK_MS && lastClick.row === cell.row && lastClick.col === cell.col;
      lastClick = { at: now, ...cell };
      if (double) {
        const word = wordAt(plain(all[cell.row] ?? ""), cell.col);
        if (word) {
          from = { row: cell.row, col: word[0] };
          to = { row: cell.row, col: word[1] };
          dragging = false;
          copySelection();
          return draw();
        }
      }
      from = to = cell;
      dragging = true;
      return draw();
    }
    // 32 is a drag with the left button held.
    if (button === 32 && dragging) {
      to = cell;
      // Dragging past the edge scrolls.
      if (e.y <= 1) return tui.scroll(1);
      if (e.y >= viewSize) return tui.scroll(-1);
      return draw();
    }
    if (button === 0 && e.release && dragging) {
      dragging = false;
      // A click without a drag clears the selection.
      if (from && to && from.row === to.row && from.col === to.col) clearSelection();
      else copySelection();
      draw();
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    if (pending) clearTimeout(pending);
    // Back on the normal screen, the transcript goes into the terminal's own scrollback.
    raw(LEAVE);
    const text = lines.join("\n");
    raw(text.endsWith("\n") || !text ? text : `${text}\n`);
  }

  const tui = {
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
    mouse,
    // Typing drops the selection.
    clearSelection() {
      if (!from) return;
      clearSelection();
      draw();
    },
  };
  return tui;
}

// Puts text on the clipboard. pbcopy on a Mac, since tmux drops the terminal escape by default. Otherwise
// OSC 52, which most terminals take.
function copy(text: string, raw: (s: string) => boolean) {
  if (process.platform === "darwin" && !process.env.SSH_CONNECTION) {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    proc.stdin.end();
    return;
  }
  raw(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

// A styled row without its styles.
function plain(row: string): string {
  return row
    .split(TOKENS)
    .filter((p) => p && p[0] !== "\x1b")
    .join("");
}

// The characters of plain text in columns from..to, both included.
function cols(text: string, from: number, to: number): string {
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (col > to) break;
    if (col >= from) out += ch;
    col += Bun.stringWidth(ch);
  }
  return out;
}

// The columns of the word (a run without spaces) at a column, or nothing on a space.
function wordAt(text: string, at: number): [number, number] | undefined {
  const cells: { ch: string; col: number }[] = [];
  let col = 0;
  for (const ch of text) {
    cells.push({ ch, col });
    col += Bun.stringWidth(ch);
  }
  let i = cells.findIndex((c, k) => c.col <= at && (cells[k + 1]?.col ?? Infinity) > at);
  if (i < 0 || /\s/.test(cells[i]!.ch)) return undefined;
  let j = i;
  while (i > 0 && !/\s/.test(cells[i - 1]!.ch)) i--;
  while (j < cells.length - 1 && !/\s/.test(cells[j + 1]!.ch)) j++;
  return [cells[i]!.col, cells[j]!.col];
}

// Draws columns from..to (both included) of a styled row in reverse video.
function highlight(row: string, from: number, to: number): string {
  let out = "";
  let col = 0;
  let on = false;
  for (const part of row.split(TOKENS)) {
    if (!part) continue;
    if (part[0] === "\x1b") {
      out += part;
      // A reset inside the selection would end the reverse video early.
      if (on && /^\x1b\[(0|27)?m$/.test(part)) out += "\x1b[7m";
      continue;
    }
    for (const ch of part) {
      if (!on && col >= from && col <= to) {
        out += "\x1b[7m";
        on = true;
      } else if (on && col > to) {
        out += "\x1b[27m";
        on = false;
      }
      out += ch;
      col += Bun.stringWidth(ch);
    }
  }
  return on ? `${out}\x1b[27m` : out;
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
