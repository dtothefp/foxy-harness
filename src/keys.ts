import { PassThrough } from "node:stream";

// Shift+Enter for a newline. A terminal normally sends a plain Enter for it, so the prompt asks for
// xterm's modifyOtherKeys, which makes modified keys arrive as escape sequences instead
// (CSI 27;mod;key~, or CSI key;mod u in tmux's csi-u format). Readline doesn't understand either, so
// they're turned back into plain bytes before it sees them. Modified Enter becomes backslash + Enter,
// the same continuation as typing a trailing \ yourself.

const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MODIFIED = /\x1b\[(?:27;(\d+);(\d+)~|(\d+);(\d+)u)/g;

export function decodeKeys(s: string): string {
  return s.replace(MODIFIED, (_, xmod, xkey, ukey, umod) => {
    const key = Number(xkey ?? ukey);
    const mod = Number(xmod ?? umod) - 1;
    const shift = mod & 1;
    const alt = mod & 2;
    const ctrl = mod & 4;
    if (key === 13) return "\\\r";
    if (key === 9 && shift) return "\x1b[Z";
    let ch = String.fromCodePoint(key);
    if (shift) ch = ch.toUpperCase();
    if (ctrl && /[a-z@[\\\]^_]/i.test(ch)) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
    return alt ? `\x1b${ch}` : ch;
  });
}

// Readline's input with key sequences decoded. Raw mode passes through to the real stdin.
export function keyInput(stdin: NodeJS.ReadStream): NodeJS.ReadableStream {
  if (!stdin.isTTY) return stdin;
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean) => (stdin.setRawMode(mode), input),
  });
  stdin.on("data", (d) => {
    // Mouse reports (SGR format) go to onMouse, not readline.
    const s = d.toString().replace(MOUSE, (_, button, x, y, kind) => {
      mouseHandler?.({ button: Number(button), x: Number(x), y: Number(y), release: kind === "m" });
      return "";
    });
    if (s) input.write(decodeKeys(s));
  });
  process.stdout.write("\x1b[>4;2m");
  process.on("exit", () => process.stdout.write("\x1b[>4;0m"));
  return input;
}

export type MouseEvent = { button: number; x: number; y: number; release: boolean };
let mouseHandler: ((e: MouseEvent) => void) | undefined;

// Receives mouse reports once a terminal has been asked for them (the full-screen view does, for the wheel).
export function onMouse(handler: (e: MouseEvent) => void) {
  mouseHandler = handler;
}
