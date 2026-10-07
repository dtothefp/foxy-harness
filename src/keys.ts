import { PassThrough } from "node:stream";

// Shift+Enter for a newline. A terminal normally sends a plain Enter for it, so the prompt asks for
// modified keys as escape sequences, two ways since terminals support one or the other. xterm's
// modifyOtherKeys (CSI 27;mod;key~, or CSI key;mod u in tmux's csi-u format) for xterm and tmux, and the
// kitty keyboard protocol (CSI key;mod u, CSI key u) for kitty, Ghostty and xterm.js terminals like Orca's
// and VS Code's. Readline doesn't understand either, so they're turned back into plain bytes before it sees
// them. Modified Enter becomes backslash + Enter, the same continuation as typing a trailing \ yourself.

const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MODIFIED = /\x1b\[(?:27;(\d+);(\d+)~|(\d+)(?::\d*)*(?:;(\d+))?u)/g;
// Bracketed paste. The terminal wraps pasted text in these.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Kitty's codes for keys with no character (caps lock, media keys and so on). Nothing to type.
const FUNCTIONAL = 57344;

export function decodeKeys(s: string): string {
  return s.replace(MODIFIED, (_, xmod, xkey, ukey, umod) => {
    const key = Number(xkey ?? ukey);
    // Kitty adds caps lock (64) and num lock (128) to the modifiers. They don't change the key.
    const mod = (Number(xmod ?? umod ?? 1) - 1) & ~192;
    if (key >= FUNCTIONAL) return "";
    const shift = mod & 1;
    const alt = mod & 2;
    const ctrl = mod & 4;
    // Cmd (super, hyper or meta) shortcuts belong to the terminal. Ghostty passes Cmd+C through when it has
    // nothing selected, and dropping the modifier would type a plain "c".
    if (mod & ~7) return "";
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
  // A paste can arrive over several reads. This holds it until the end marker.
  let pasted: string | undefined;
  stdin.on("data", (d) => {
    let s = d.toString();
    let keys = "";
    while (s) {
      if (pasted === undefined) {
        const start = s.indexOf(PASTE_START);
        keys += typed(start < 0 ? s : s.slice(0, start));
        if (start < 0) break;
        pasted = "";
        s = s.slice(start + PASTE_START.length);
        continue;
      }
      const end = s.indexOf(PASTE_END);
      pasted += end < 0 ? s : s.slice(0, end);
      if (end < 0) break;
      // A paste goes in as it is, without decoding. Readline sees the markers when it stays more than one line.
      const text = pasteHandler ? pasteHandler(pasted) : pasted;
      keys += text.includes("\n") || text.includes("\r") ? `${PASTE_START}${text}${PASTE_END}` : text;
      pasted = undefined;
      s = s.slice(end + PASTE_END.length);
    }
    const passed = keys && keyFilter ? keyFilter(keys) : keys;
    if (passed) input.write(passed);
  });
  process.stdout.write("\x1b[>4;2m\x1b[>1u");
  process.on("exit", () => process.stdout.write("\x1b[>4;0m\x1b[<u"));
  return input;
}

// Typed keys. Mouse reports (SGR format) go to onMouse, not readline, and modified keys are decoded.
function typed(s: string): string {
  const keys = s.replace(MOUSE, (_, button, x, y, kind) => {
    mouseHandler?.({ button: Number(button), x: Number(x), y: Number(y), release: kind === "m" });
    return "";
  });
  return keys && decodeKeys(keys);
}

let pasteHandler: ((text: string) => string) | undefined;

// Sees each paste and returns what goes in the input instead, like a placeholder for a big one.
export function onPaste(handler: (text: string) => string) {
  pasteHandler = handler;
}

export type MouseEvent = { button: number; x: number; y: number; release: boolean };
let mouseHandler: ((e: MouseEvent) => void) | undefined;

// Receives mouse reports once a terminal has been asked for them (the full-screen view does, for the wheel).
export function onMouse(handler: (e: MouseEvent) => void) {
  mouseHandler = handler;
}

let keyFilter: ((keys: string) => string) | undefined;

// Sees decoded keys before readline does and returns what readline should get. The slash command menu uses
// it to take arrows, tab and enter while it's open.
export function onKeys(filter: (keys: string) => string) {
  keyFilter = filter;
}
