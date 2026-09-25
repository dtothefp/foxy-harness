import { format } from "node:util";

// A status line for quiet stretches of a turn. It sits on its own line with elapsed seconds and is
// erased the moment anything else prints, so it can stay armed for the whole turn. busy() shows it after
// `after` ms (right away while waiting on the model). Once something has printed, it comes back only
// after QUIET_MS with no output, like a long bash command or a pause mid-reply.
//
// It also sets the terminal title the way Claude Code does, which is how session managers (Orca, tmux
// pane titles in Agent of Empires) tell whether an agent is busy. A braille spinner frame while working,
// ✋ while a permission question waits, ✳ when idle at the prompt.
//
// Text typed mid-turn (a steer being drafted) shows at the end of the line, since readline's own echo
// is muted while the agent is printing.

const QUIET_MS = 5000;
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function createSpinner(out: NodeJS.WriteStream = process.stdout) {
  const original = out.write.bind(out) as (...args: unknown[]) => boolean;
  const write = (s: string) => original(s);
  let label: string | undefined;
  let started = 0;
  let quietSince = 0;
  let threshold = 0;
  let shown = false;
  let atLineStart = true;
  let frame = 0;
  let draft = "";
  const now = () => performance.now();
  const elapsed = () => Math.round((now() - started) / 1000);
  const title = (glyph: string) => out.isTTY && write(`\x1b]0;${glyph} foxy-harness\x07`);

  function clear() {
    if (shown) write("\r\x1b[2K");
    shown = false;
  }

  function tick() {
    // Only on an empty line, so it never lands in the middle of a line or a question waiting for input.
    if (!label || !atLineStart || (!draft && now() - quietSince < threshold)) return;
    shown = true;
    const status = `${label}… ${elapsed()}s`;
    // Keep the draft on one line, showing its end since that's where the cursor is.
    const room = (out.columns || 80) - status.length - 5;
    const typed = draft.length > room ? `…${draft.slice(-(room - 1))}` : draft;
    write(
      `\r\x1b[2K\x1b[36m${FRAMES[frame++ % FRAMES.length]}\x1b[0m \x1b[2m${status}\x1b[0m${draft && room > 1 ? `  \x1b[36m›\x1b[0m ${typed}` : ""}`,
    );
  }

  if (out.isTTY) {
    out.write = ((chunk: unknown, ...rest: unknown[]) => {
      clear();
      const s = typeof chunk === "string" ? chunk : String(chunk ?? "");
      if (s) {
        atLineStart = s.endsWith("\n");
        quietSince = now();
        threshold = QUIET_MS;
      }
      return original(chunk, ...rest);
    }) as typeof out.write;
    // Bun's console.log writes to the fd directly, not through stdout.write. Send it through, and clear
    // the line before anything goes to stderr on the same terminal.
    console.log = (...args: unknown[]) => void out.write(`${format(...args)}\n`);
    const error = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      clear();
      error(...args);
    };
    setInterval(tick, 100).unref();
    process.on("exit", () => {
      clear();
      write("\x1b]0;\x07");
    });
  }

  return {
    busy(text: string, after = 0) {
      label = text;
      started = quietSince = now();
      threshold = after;
      title(FRAMES[0]!);
      tick();
    },
    // Returns the seconds since busy(), for messages like "compacted in 12s".
    idle() {
      const secs = elapsed();
      label = undefined;
      draft = "";
      clear();
      title("✳");
      return secs;
    },
    // What's typed so far mid-turn. Shown right away, not after the quiet stretch.
    draft(text: string) {
      if (text === draft) return;
      draft = text;
      if (!text) clear();
      tick();
    },
    // Waiting on the user mid-turn, like a permission question.
    waiting() {
      label = undefined;
      clear();
      title("✋");
    },
  };
}
