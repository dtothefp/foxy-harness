// A status line for quiet stretches of a turn. It sits on its own line with elapsed seconds and is
// erased the moment anything else prints, so it can stay armed for the whole turn. busy() shows it after
// `after` ms (right away while waiting on the model). Once something has printed, it comes back only
// after QUIET_MS with no output, like a long bash command or a pause mid-reply.

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
  const now = () => performance.now();
  const elapsed = () => Math.round((now() - started) / 1000);

  function clear() {
    if (shown) write("\r\x1b[2K");
    shown = false;
  }

  function tick() {
    // Only on an empty line, so it never lands in the middle of a line or a question waiting for input.
    if (!label || !atLineStart || now() - quietSince < threshold) return;
    shown = true;
    write(`\r\x1b[2K\x1b[36m${FRAMES[frame++ % FRAMES.length]}\x1b[0m \x1b[2m${label}… ${elapsed()}s\x1b[0m`);
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
    setInterval(tick, 100).unref();
    process.on("exit", clear);
  }

  return {
    busy(text: string, after = 0) {
      label = text;
      started = quietSince = now();
      threshold = after;
      tick();
    },
    // Returns the seconds since busy(), for messages like "compacted in 12s".
    idle() {
      const secs = elapsed();
      label = undefined;
      clear();
      return secs;
    },
  };
}
