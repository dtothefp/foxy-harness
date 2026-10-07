import { format } from "node:util";
import { BEGIN, cut, END, FRAMES, type InputView, type Mouse, panelRows, wrap } from "./tui.ts";

// The inline view, like Codex CLI and pi. Finished lines go to the terminal once, on the normal screen, so
// they're in its own scrollback and the terminal does the scrolling, selecting and copying. Only a small live
// region at the bottom is redrawn (the line still being written, then the panel). Each redraw moves the cursor
// up to the top of that region, clears to the end of the screen, writes any lines that finished since the last
// frame, and draws the region again, all in one synchronized write.
//
// Same interface as createTui, so cli.ts picks one or the other. Scrolling and the mouse are the terminal's
// here, so those calls do nothing.

// Output that isn't a color or style would move the cursor and throw off the row count.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SGR = /^\x1b\[[0-9;]*m$/;

export function createInlineTui(view: () => InputView, out: NodeJS.WriteStream = process.stdout) {
  const original = out.write.bind(out) as (...args: unknown[]) => boolean;
  const raw = (s: string) => original(s);
  let active = false;
  let label: string | undefined;
  let waiting = false;
  let started = 0;
  let frame = 0;
  let flash = "";
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;

  // Lines that finished since the last frame, and the one still being written.
  let settled: string[] = [];
  let partial = "";
  // The live region as last drawn. The width of each row, and the row the cursor was left on, so the next
  // frame knows how far up to go. Widths rather than a count, since a terminal that reflows on resize wraps
  // each old row again at the new width.
  let drawn: number[] = [];
  let caretRow = 0;

  const height = () => out.rows || 24;
  const width = () => out.columns || 80;
  const elapsed = () => Math.round((performance.now() - started) / 1000);
  const title = (glyph: string) => out.isTTY && raw(`\x1b]0;${glyph} foxy-harness\x07`);
  const clean = (s: string) => s.replace(CSI, (m) => (SGR.test(m) ? m : ""));

  function append(s: string) {
    const parts = s.replace(/\r\n/g, "\n").split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        settled.push(partial);
        partial = "";
      }
      // A carriage return starts the line over.
      const cr = part.lastIndexOf("\r");
      partial = cr >= 0 ? part.slice(cr + 1) : partial + part;
    });
  }

  function status(): string {
    if (label) return `\x1b[36m${FRAMES[frame % FRAMES.length]}\x1b[0m \x1b[2m${label}… ${elapsed()}s\x1b[0m`;
    if (waiting) return "✋ \x1b[2mWaiting for your answer\x1b[0m";
    return "";
  }

  // Moves from where the cursor was left to the top of the live region and clears from there down.
  function erase(): string {
    const w = width();
    // Rows above the caret's row, each wrapped again at the current width.
    let up = 0;
    for (let i = 0; i < caretRow && i < drawn.length; i++) up += Math.max(1, Math.ceil(drawn[i]! / w));
    // tmux moves the whole screen into its history when it's cleared from the top left cell, which leaves a
    // copy of the panel in the scrollback when the region starts on the top row. So the first row is cleared
    // on its own and the rest from the row below. The region is always a few rows, so there is a row below.
    const clear = drawn.length > 1 ? "\r\x1b[2K\x1b[B\x1b[J\x1b[A" : "\r\x1b[J";
    drawn = [];
    caretRow = 0;
    return `${up ? `\x1b[${up}A` : ""}${clear}`;
  }

  function draw() {
    pending = undefined;
    if (!active) return;
    const w = width();
    let seq = BEGIN + erase();
    for (const line of settled) seq += `${clean(line)}\x1b[0m\r\n`;
    settled = [];
    const p = panelRows(view(), w, height(), status(), flash || undefined);
    // The region stays shorter than the screen, or the rows scrolled off the top couldn't be reached to redraw.
    // The line being written shows its last rows if it's too long.
    const room = Math.max(0, height() - 1 - p.rows.length);
    const live = partial ? wrap(clean(partial), w - 1).slice(-room) : [];
    const rows = [...live, ...p.rows].map((r) => cut(r, w));
    drawn = rows.map((r) => Bun.stringWidth(r));
    seq += rows.join("\r\n");
    // The cursor goes to the input's caret.
    caretRow = live.length + p.caret.row;
    const back = rows.length - 1 - caretRow;
    raw(`${seq}${back > 0 ? `\x1b[${back}A` : ""}\r${p.caret.col ? `\x1b[${p.caret.col}C` : ""}${END}`);
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

  function note(text: string) {
    flash = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ((flash = ""), draw()), 1500);
    flashTimer.unref?.();
    draw();
  }

  // Takes the panel away and leaves the output where it is, with the line being written finished.
  function stop() {
    if (!active) return;
    active = false;
    if (pending) clearTimeout(pending);
    let seq = BEGIN + erase();
    for (const line of settled) seq += `${clean(line)}\x1b[0m\r\n`;
    if (partial) seq += `${clean(partial)}\x1b[0m\r\n`;
    settled = [];
    partial = "";
    raw(seq + END);
  }

  return {
    start() {
      if (!out.isTTY || active) return;
      active = true;
      draw();
    },
    stop,
    render: draw,
    // Nothing to scroll, the terminal has the output. Keypresses land here, so it redraws the input.
    scroll(_by: number) {
      draw();
    },
    page: () => 0,
    // A new prompt starts on its own line. The terminal scrolls it into view.
    newPrompt() {
      if (active && partial) out.write("\n");
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
    waiting() {
      label = undefined;
      waiting = true;
      title("✋");
      draw();
    },
    mouse(_e: Mouse) {},
    note,
    clearSelection() {},
  };
}
