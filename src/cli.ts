#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runAcp } from "./acp.ts";
import { addModelExports } from "./envrc.ts";
import { setupAoe } from "./aoe.ts";
import { login } from "./auth/codex-oauth.ts";
import { chooseProvider, type Frontend, startSession } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { attachmentsInPrompt } from "./attachments.ts";
import { ago, describeSession, shortModel } from "./inspect.ts";
import { titleSession } from "./titles.ts";
import { transcript } from "./transcript.ts";
import {
  findSession,
  loadSession,
  markClosed,
  markOpen,
  providerFamily,
  SESSIONS,
  type Session,
  sessionFiles,
  sessionPath,
  sessionState,
  sessionsIn,
  sessionTitle,
} from "./sessions.ts";
import { listModels } from "./providers/codex.ts";
import type { Usage } from "./providers/types.ts";
import { type Command, commands, expandSkill, matchCommands } from "./commands.ts";
import { keyInput, onKeys, onMouse } from "./keys.ts";
import { markdownStream } from "./markdown.ts";
import { createTui } from "./tui.ts";
import { renderChanges } from "./render.ts";
import { userShell } from "./shell.ts";
import type { FileChange } from "./tools/types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

// Styled Markdown on a terminal, raw text when piped.
const md = process.stdout.isTTY ? markdownStream((s) => process.stdout.write(s)) : undefined;

// Bash calls show the model's plain-language description, not the command. The command still shows
// in permission prompts and when it fails.
const bashInput = (input: unknown) => input as { command?: string; description?: string };
const describe = (input: unknown) => {
  const { command, description } = bashInput(input);
  return description?.trim() || `$ ${command?.split("\n")[0]}`;
};

// web_search shows its query, or the page when Codex's search opens one. web_fetch shows its URL.
const webLabel = (name: string, input: unknown) => {
  const { query, url } = (input ?? {}) as { query?: string; url?: string };
  return name === "web_fetch" ? `Fetch(${url})` : query != null ? `Search(${JSON.stringify(query)})` : `Open(${url})`;
};
const isWeb = (name: string) => name === "web_search" || name === "web_fetch";

// The pinned input at the bottom draws from readline's line plus earlier lines of a multi-line prompt.
const tui = createTui(() => ({
  lines: [...pendingLines, rl.line],
  cursor: rl.cursor,
  label: question,
  hint: question
    ? "enter answers · esc stops the turn"
    : [...pendingLines, rl.line][0]?.startsWith("!")
      ? "shell command · enter runs it, the model sees the output with your next prompt"
      : current
        ? "enter steers the turn · esc interrupts"
        : picker
          ? "no sessions match"
          : "enter sends · shift+enter for a newline · / for commands · ← sessions · ctrl+d exits",
  menu: picker ? pickerView() : menuView(),
}));

// The slash command menu. It's open while the input is just a slash and a name, with no space yet.
// Arrows pick, tab completes, enter runs the pick, esc closes it until the text changes.
let slashCommands: Command[] = [];
let menuSelected = 0;
let menuQuery: string | undefined;
let menuClosedFor: string | undefined;
function menuItems(): Command[] {
  const line = rl.line;
  if (!slashCommands.length || question || pendingLines.length || !/^\/\S*$/.test(line) || line === menuClosedFor) return [];
  if (line !== menuQuery) {
    menuQuery = line;
    menuSelected = 0;
  }
  return matchCommands(slashCommands, line.slice(1));
}
function menuView() {
  const items = menuItems();
  return items.length ? { items, selected: Math.min(menuSelected, items.length - 1) } : undefined;
}
function menuKeys(keys: string): string {
  if (picker) return pickerKeys(keys);
  if ((keys === "\x1b[D" || keys === "\x1bOD") && waiter && !rl.line && !pendingLines.length) {
    void openPicker();
    return "";
  }
  const items = menuItems();
  if (!items.length) return keys;
  const pick = items[Math.min(menuSelected, items.length - 1)]!;
  if (keys === "\x1b[A" || keys === "\x1bOA") menuSelected = (menuSelected - 1 + items.length) % items.length;
  else if (keys === "\x1b[B" || keys === "\x1bOB") menuSelected = (menuSelected + 1) % items.length;
  else if (keys === "\x1b") menuClosedFor = rl.line;
  else if (keys === "\t" || keys === "\r") {
    takeLine();
    rl.write(keys === "\t" ? `/${pick.name} ` : `/${pick.name}`);
    if (keys === "\r") return keys;
  } else return keys;
  tui.render();
  return "";
}

// When and where a session ran, for the session lists. "2 h ago · claude-monorepo (main) · 4 turns".
function sessionPlace(s: Session, mtime: Date) {
  const turns = s.messages.filter((m) => m.role === "user").length;
  return `${ago(mtime)} · ${basename(s.cwd)}${s.branch ? ` (${s.branch})` : ""} · ${turns} turn${turns === 1 ? "" : "s"}`;
}

// The session list, like Claude Code's. Left arrow on an empty input opens it. It has every directory's
// sessions, newest first, narrowed by what's typed. Enter switches to the pick, esc closes the list.
type SessionItem = { name: string; description: string; id: string; cwd: string; search: string };
let picker: { all: SessionItem[]; selected: number; query: string } | undefined;
async function openPicker() {
  const recent = await sessionsIn(undefined, 50);
  const all = await Promise.all(
    recent.map(async (r) => {
      const state = r.id === sessionId ? "this session" : await sessionState(r.id);
      const title = sessionTitle(r.session);
      return {
        name: title || "(no prompt)",
        description: `${state ? `[${state}] ` : ""}${sessionPlace(r.session, r.mtime)}`,
        id: r.id,
        cwd: r.session.cwd,
        search: `${r.session.cwd} ${title}`.toLowerCase(),
      };
    }),
  );
  if (!all.length) return tui.note("No saved sessions");
  picker = { all, selected: 0, query: "" };
  tui.render();
}
function pickerItems(): SessionItem[] {
  if (!picker) return [];
  if (rl.line !== picker.query) {
    picker.query = rl.line;
    picker.selected = 0;
  }
  const words = rl.line.toLowerCase().split(/\s+/).filter(Boolean);
  return picker.all.filter((s) => words.every((w) => s.search.includes(w)));
}
function pickerView() {
  const items = pickerItems();
  if (!items.length) return undefined;
  const selected = Math.min(picker!.selected, items.length - 1);
  return { items, selected, prefix: "", title: "sessions · ↑↓ pick · enter switches · esc closes · type to narrow" };
}
function pickerKeys(keys: string): string {
  const items = pickerItems();
  const pick = items[Math.min(picker!.selected, items.length - 1)];
  if (keys === "\x1b[A" || keys === "\x1bOA") picker!.selected = (picker!.selected - 1 + items.length) % Math.max(1, items.length);
  else if (keys === "\x1b[B" || keys === "\x1bOB") picker!.selected = (picker!.selected + 1) % Math.max(1, items.length);
  else if (keys === "\x1b" || ((keys === "\x1b[C" || keys === "\x1bOC") && !rl.line)) {
    picker = undefined;
    takeLine();
  } else if (keys === "\r") {
    if (pick) void switchTo(pick);
  } else return keys;
  tui.render();
  return "";
}
async function switchTo(pick: SessionItem) {
  if (pick.id === sessionId) {
    picker = undefined;
    takeLine();
    return tui.render();
  }
  if ((await sessionState(pick.id)) === "open") return tui.note("That session is open in another terminal");
  if (!existsSync(pick.cwd)) return tui.note(`${pick.cwd} is gone`);
  picker = undefined;
  tui.stop();
  // Stop reading keys, so the next foxy-harness gets them.
  process.stdin.removeAllListeners("data");
  process.stdin.pause();
  process.stdin.setRawMode?.(false);
  await hooks.emit({ type: "SessionEnd", sessionId });
  await markClosed(sessionId);
  await handOff(pick.id, pick.cwd);
}

// The picked session runs in a new foxy-harness in its own directory, as `--resume <id>` would start it. One
// already started this way hands the next pick back to the first by writing it to FOXY_HARNESS_NEXT and
// exiting, so switching around doesn't stack up processes.
async function handOff(id: string, dir: string): Promise<never> {
  const next = process.env.FOXY_HARNESS_NEXT;
  if (next) {
    await Bun.write(next, JSON.stringify({ id, cwd: dir }));
    process.exit(0);
  }
  const file = join(SESSIONS, `.next-${process.pid}.json`);
  // A compiled binary runs itself, `bun src/cli.ts` runs the script again.
  const self = Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
  let target: { id: string; cwd: string } | undefined = { id, cwd: dir };
  let code = 0;
  while (target) {
    await rm(file, { force: true });
    const child = Bun.spawn([...self, "--resume", target.id, ...(yoloFlag ? ["--yolo"] : [])], {
      cwd: target.cwd,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, FOXY_HARNESS_NEXT: file },
    });
    code = await child.exited;
    target = await Bun.file(file)
      .json()
      .catch(() => undefined);
  }
  await rm(file, { force: true });
  process.exit(code);
}

// Piped output only. Whether the model's text stopped partway through a line.
let midLine = false;

const args = process.argv.slice(2);
const flag = (...names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 ? args.splice(i, 1) && true : false;
};
const option = (...names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
// A flag with an optional value, like Claude Code's --resume [id]. The value is taken only if it looks like
// a session id, so `--resume "fix the tests"` still reads the prompt.
const optionalOption = (...names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  const value = /^[0-9a-f][0-9a-f-]{3,}$/i.test(args[i + 1] ?? "") ? args[i + 1]! : "";
  args.splice(i, value ? 2 : 1);
  return value;
};

const yoloFlag = flag("--yolo");
const demoUnknownTool = flag("--demo-unknown-tool");
// Same flags as Claude Code. --continue resumes the newest session in this directory, --resume <id> a
// given one (an id prefix is enough), --resume alone lists this directory's sessions to pick from.
// --session-id starts a new session with a set id, for tools that track sessions by id.
const continueFlag = flag("--continue", "-c");
const resumeArg = optionalOption("--resume", "-r");
const sessionIdArg = option("--session-id");
const config = await loadConfig();
// Skip permission prompts. HARNESS_YOLO=1 makes it the default, like Claude Code's bypassPermissions mode.
const yolo = yoloFlag || config.get("HARNESS_YOLO") === "1";
const modelFlag = option("--model");
const providerFlag = option("--provider");

// Agent Client Protocol over stdio, for editors and session managers that speak it (Zed, Paseo).
if (flag("--acp")) await runAcp(config, { provider: providerFlag, model: modelFlag, yolo });

if (args[0] === "login") {
  await login();
  process.exit(0);
}
// `foxy-harness aoe [live|tmux] [--check]` sets up Agent of Empires and tmux for the harness.
if (args[0] === "aoe") {
  const mode = args[1] === "tmux" ? "tmux" : "live";
  if (args[1] && !["live", "tmux", "--check"].includes(args[1])) {
    console.error(red(`Unknown aoe mode "${args[1]}". Use live or tmux.`));
    process.exit(1);
  }
  try {
    console.log(await setupAoe({ mode, check: args.includes("--check") }));
    process.exit(0);
  } catch (err) {
    console.error(red((err as Error).message));
    process.exit(1);
  }
}
// `foxy-harness envrc [name...]` adds empty HARNESS_MODEL_<NAME> exports to ~/.envrc for direnv.
if (args[0] === "envrc") {
  const names = args.slice(1);
  console.log(await addModelExports(names.length ? names : undefined));
  process.exit(0);
}
if (args[0] === "models") {
  const { models } = (await listModels()) as { models: { slug: string; description?: string; visibility?: string }[] };
  for (const m of models.filter((m) => m.visibility !== "hide")) console.log(`${m.slug.padEnd(24)} ${dim(m.description ?? "")}`);
  process.exit(0);
}
// `foxy-harness last [id-prefix]` summarizes the newest session file (or a given one).
if (args[0] === "last") {
  const found = await findSession(args[1]);
  if (!found) {
    console.error(red("No saved sessions."));
    process.exit(1);
  }
  const session = (await Bun.file(found.path).json()) as Session;
  console.log(describeSession(session, `session ${found.id.slice(0, 8)} · ${ago(found.mtime)}`));
  process.exit(0);
}

// `foxy-harness transcript [id-prefix] [--max chars]` prints a session as plain text, to carry its context
// into another session. `--list` shows recent sessions.
if (args[0] === "transcript") {
  const rest = args.slice(1);
  if (rest.includes("--list")) {
    for (const f of (await sessionFiles()).slice(0, 20)) {
      const s = await loadSession(f.path).catch(() => undefined);
      if (s) console.log(`${f.id.slice(0, 8)}  ${ago(f.mtime).padEnd(12)}  ${sessionTitle(s).slice(0, 80)}`);
    }
    process.exit(0);
  }
  const maxAt = rest.indexOf("--max");
  const max = maxAt >= 0 ? Number(rest[maxAt + 1]) : undefined;
  const prefix = rest.find((a, i) => !a.startsWith("--") && i !== maxAt + 1);
  const found = await findSession(prefix);
  if (!found) {
    console.error(red(prefix ? `No session starting with ${prefix}.` : "No saved sessions."));
    process.exit(1);
  }
  console.log(transcript(found.id, await loadSession(found.path), max || undefined));
  process.exit(0);
}

const cwd = process.cwd();
const input = keyInput(process.stdin);
// Readline does the line editing, but the input is drawn in the pinned panel, so its own echo is muted
// once the panel is up.
const screen = {
  muted: false,
  write: (...a: Parameters<typeof process.stdout.write>) => screen.muted || process.stdout.write(...a),
  get columns() {
    return process.stdout.columns;
  },
  get rows() {
    return process.stdout.rows;
  },
  on: (event: string, fn: () => void) => process.stdout.on(event, fn),
  off: (event: string, fn: () => void) => process.stdout.off(event, fn),
  removeListener: (event: string, fn: () => void) => process.stdout.removeListener(event, fn),
};
const rl = createInterface({ input, output: screen as unknown as NodeJS.WritableStream, terminal: process.stdin.isTTY });

const resumed = await resumeTarget();
const sessionId = resumed?.id ?? sessionIdArg ?? crypto.randomUUID();

function exit(message: string): never {
  console.error(red(message));
  process.exit(1);
}

// The session --continue, --resume or --session-id points at, if any.
async function resumeTarget(): Promise<{ id: string; session: Session; mtime: Date } | undefined> {
  if (sessionIdArg) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionIdArg)) exit("--session-id must be a UUID.");
    if (await Bun.file(sessionPath(sessionIdArg)).exists()) exit(`Session ${sessionIdArg} is already in use. Use --resume to pick it up.`);
    return;
  }
  if (continueFlag) {
    const [latest] = await sessionsIn(cwd, 1);
    if (!latest) console.log(dim("No earlier session in this directory, starting a new one."));
    return latest;
  }
  if (resumeArg === undefined) return;
  if (resumeArg) {
    const found = await findSession(resumeArg);
    if (!found) exit(`No session starting with ${resumeArg}.`);
    return { ...found, session: await loadSession(found.path) };
  }
  const recent = await sessionsIn(cwd, 10);
  if (!recent.length) {
    console.log(dim("No earlier sessions in this directory, starting a new one."));
    return;
  }
  if (!process.stdin.isTTY) exit("--resume without an id needs a terminal to pick from. Pass an id.");
  recent.forEach((r, i) => {
    console.log(
      `${cyan(String(i + 1).padStart(2))}  ${sessionTitle(r.session).slice(0, 60)}  ${dim(`${sessionPlace(r.session, r.mtime)} · ${r.id.slice(0, 8)}`)}`,
    );
  });
  const answer = (await rl.question(dim(`Resume which? [1] `))).trim() || "1";
  const pick = recent[Number(answer) - 1];
  if (!pick) exit(`No session ${answer}.`);
  return pick;
}

// The running turn. ctrl+c aborts it, which also cancels a permission question it's waiting on.
let current: AbortController | undefined;

// Lines of a multi-line prompt before the one being edited.
const pendingLines: string[] = [];
// A permission question being asked in the input.
let question: string | undefined;

async function ask(text: string) {
  // A half-typed steer is set aside so it isn't taken as the answer, then put back.
  const draft = [...pendingLines.splice(0), takeLine()];
  question = `${text} [Y/n/reason] `;
  tui.render();
  let answer: string;
  try {
    answer = (await rl.question(question, { signal: current?.signal })).trim();
  } finally {
    question = undefined;
    pendingLines.push(...draft.slice(0, -1));
    rl.write(draft.at(-1)!);
    tui.render();
  }
  if (answer === "" || /^y(es)?$/i.test(answer)) return;
  return { block: /^n(o)?$/i.test(answer) ? "user declined" : answer };
}

// Empties readline's line and returns what was on it.
function takeLine() {
  const line = rl.line;
  rl.write(null, { ctrl: true, name: "e" });
  rl.write(null, { ctrl: true, name: "u" });
  return line;
}

// The model reads the full tool result. The user sees a glimpse on success (nothing for bash) and more on
// failure, since that's what they need to see.
function showToolEnd(output: string, ok: boolean, changes: FileChange[] | undefined, name: string, input: unknown) {
  if (ok && (changes || name === "bash")) return;
  const lines = output.trimEnd().split("\n");
  if (ok && name === "read_file") return console.log(dim(`  ⎿ ${output.startsWith("Attached ") ? "attached" : `${lines.length} lines`}`));
  if (ok && name === "web_fetch") return console.log(dim(`  ⎿ ${output.includes("Attached ") ? "attached" : `${lines.length} lines`}`));
  if (name === "bash" && yolo) console.log(dim(`  $ ${bashInput(input).command}`));
  const max = ok ? 4 : 12;
  const shown = lines
    .slice(0, max)
    .map((l) => `  ${l}`)
    .join("\n");
  const more = lines.length > max ? `\n  … ${lines.length - max} more lines` : "";
  console.log(ok ? dim(shown + more) : red(shown + more));
}

const frontend: Frontend = {
  // Without --yolo, edits show their diff and bash its command, then ask.
  askPermission: yolo
    ? undefined
    : async (e) => {
        tui.waiting();
        if (e.changes) console.log(renderChanges(e.changes));
        else if (e.tool === "web_fetch") console.log(`${cyan("⏺")} ${webLabel(e.tool, e.input)}`);
        else console.log(`${cyan("⏺")} ${describe(e.input)}\n${dim(`  $ ${bashInput(e.input).command}`)}`);
        return ask(e.changes ? "apply?" : e.tool === "web_fetch" ? "fetch?" : "run?");
      },
  notice: (line) => console.log(dim(`⏺ ${line}`)),
  onText: (d) => {
    if (md) return md.push(d);
    process.stdout.write(d);
    midLine = !d.endsWith("\n");
  },
  onReasoning: (s) => console.log(dim(`\x1b[3m✻ ${s}\x1b[23m`)),
  onToolStart: (name, input, changes) => {
    // Hosted searches are reported mid-reply, so end the line the model was writing.
    md?.end();
    if (midLine) process.stdout.write("\n");
    midLine = false;
    tui.busy("Running");
    const args = input as { path?: string };
    // Without --yolo the permission prompt already printed the diff or command.
    if (changes) {
      if (yolo) console.log(renderChanges(changes));
    } else if (name === "bash") {
      if (yolo) console.log(`${cyan("⏺")} ${describe(input)}`);
    } else if (name === "read_file") console.log(`${cyan("⏺")} Read(${args.path})`);
    else if (name === "web_fetch") {
      if (yolo) console.log(`${cyan("⏺")} ${webLabel(name, input)}`);
    } else if (isWeb(name)) console.log(`${cyan("⏺")} ${webLabel(name, input)}`);
    else console.log(`${cyan("⏺")} ${name}(${JSON.stringify(input).slice(0, 120)})`);
  },
  onToolEnd: (output, ok, changes, name, input) => {
    showToolEnd(output, ok, changes, name, input);
    // The model is called next.
    tui.busy("Thinking");
  },
  onStep: ({ ms, firstTokenMs, usage }) => {
    md?.end();
    const u = usage as Usage;
    const ttft = firstTokenMs ? `ttft ${(firstTokenMs / 1000).toFixed(1)}s · ` : "";
    const used =
      u.inputTokens != null ? ` · ${Math.round((100 * (u.inputTokens + (u.outputTokens ?? 0))) / agent.contextWindow)}% context` : "";
    console.log(
      dim(
        `\n${ttft}${(ms / 1000).toFixed(1)}s · in ${u.inputTokens ?? "?"} (cached ${u.cachedTokens ?? 0}) · out ${u.outputTokens ?? "?"}${u.thinkingTokens ? ` (thinking ${u.thinkingTokens})` : ""}${used}`,
      ),
    );
  },
  onSteer: (text) => console.log(`${cyan("›")} ${text.split("\n")[0]}${text.includes("\n") ? dim(" …") : ""}`),
  onCompact: (info) => {
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    if (info.kind === "clear") return console.log(dim(`⏺ Cleared old tool results (~${k(info.freedTokens)} tokens)`));
    if (info.kind === "start") return tui.busy(info.trigger === "auto" ? "Context is filling up, compacting" : "Compacting");
    const secs = tui.idle();
    if (info.kind === "failed") console.log(red(`⏺ Compaction failed after ${secs}s: ${info.error}`));
    else
      console.log(
        dim(
          `⏺ Compacted conversation, ${info.native ? "server-side" : "summary"}, ${secs}s (~${k(info.before)} → ~${k(info.after)} tokens)`,
        ),
      );
    tui.busy("Thinking");
  },
};

let session: Awaited<ReturnType<typeof startSession>>;
try {
  session = await startSession({
    config,
    cwd,
    sessionId,
    choice: chooseProvider(config, { provider: providerFlag, model: modelFlag }, resumed?.session),
    frontend,
    resumed: resumed?.session,
    // Advertise a tool the harness never runs, to watch the "Unknown tool" path.
    fakeTools: demoUnknownTool
      ? [
          {
            name: "get_weather",
            description: "Get the current weather for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ]
      : undefined,
  });
} catch (err) {
  exit(err instanceof Error ? err.message : String(err));
}
const { agent, hooks, instructions, skills, providerFor } = session;
slashCommands = commands(skills);
const provider = agent.provider;
// Titles come from HARNESS_TITLE_MODEL, else Haiku for Claude, else the session's own model.
const titleModel = () => {
  const name = config.get("HARNESS_TITLE_MODEL") ?? (providerFamily(provider.name) === "claude" ? "haiku" : undefined);
  return name ? providerFor(name) : undefined;
};

// A turn cut off by HARNESS_MAX_STEPS would otherwise look finished.
hooks.on("Stop", (e) => {
  if (e.reason !== "max_steps") return;
  tui.idle();
  const n = Number(config.get("HARNESS_MAX_STEPS"));
  console.log(red(`⏺ Stopped after ${n} step${n === 1 ? "" : "s"} (HARNESS_MAX_STEPS). Say "continue" to keep going.`));
});

// Bracketed paste. The terminal wraps pasted text in markers (readline reports them as paste-start and
// paste-end keypresses), so newlines inside a paste don't submit. Enter after the paste does.
// A trailing backslash continues the prompt on the next line.
let pasting = false;
if (process.stdin.isTTY) {
  process.stdout.write("\x1b[?2004h");
  process.on("exit", () => process.stdout.write("\x1b[?2004l"));
  input.on("keypress", (_s, key?: { name?: string }) => {
    if (key?.name === "paste-start") pasting = true;
    if (key?.name === "paste-end") pasting = false;
    // Esc stops a turn, like ctrl+c.
    if (key?.name === "escape" && current && !pasting) current.abort();
    // PgUp/PgDn scroll back through the output. Typing anything else jumps back to the bottom.
    if (key?.name === "pageup") return tui.scroll(tui.page());
    if (key?.name === "pagedown") return tui.scroll(-tui.page());
    tui.clearSelection();
    tui.scroll(-Infinity);
  });
}

// Waiting for the next prompt, when idle.
let waiter: ((prompt: string) => void) | undefined;

// Enter sends the prompt. During a turn it steers it instead. The message joins the same run at the next
// step, after the tool calls in flight finish, rather than starting a second agent or waiting for the
// turn to end.
rl.on("line", (line) => {
  if (pasting) return void pendingLines.push(line);
  if (line.endsWith("\\")) {
    pendingLines.push(line.slice(0, -1));
    return tui.render();
  }
  const text = [...pendingLines.splice(0), line].join("\n").trim();
  tui.render();
  if (!current) {
    // Enter before the prompt is ready keeps the text in the input.
    if (!waiter) return void rl.write(text.replace(/\n/g, " "));
    waiter(text);
    waiter = undefined;
    return;
  }
  if (!text) return;
  if (text.startsWith("/") || text.startsWith("!")) {
    rl.write(text.replace(/\n/g, " "));
    tui.render();
    return console.log(dim("⏺ Commands and ! shell commands wait for the turn to finish. esc stops it."));
  }
  console.log(dim("⏺ Queued, it goes in after the current step"));
  void attachmentsInPrompt(text, cwd).then(({ attachments }) => agent.steer(text, attachments.length ? attachments : undefined));
});

function readPrompt(): Promise<string> {
  return new Promise((resolve) => {
    waiter = resolve;
    tui.idle();
    if (screen.muted) return;
    // Piped input, without the panel.
    process.stdout.write("\n");
    rl.setPrompt(`${cyan("›")} `);
    rl.prompt(true);
  });
}

// The prompt as sent, at the top of the screen with its reply below.
function showPrompt(prompt: string) {
  if (!screen.muted) return;
  tui.toTop();
  const [first, ...rest] = prompt.split("\n");
  console.log(`${cyan("›")} ${first}${rest.map((l) => `\n  ${l}`).join("")}\n`);
}

async function turn(prompt: string) {
  const controller = new AbortController();
  current = controller;
  tui.render();
  try {
    if (prompt === "/model" || prompt.startsWith("/model ")) {
      const name = prompt.slice("/model".length).trim();
      if (name) agent.provider = providerFor(name);
      console.log(
        dim(
          `⏺ ${name ? "Switched to" : "Using"} ${shortModel(agent.provider.model)} (${agent.provider.name})${name ? "" : ". /model <name> switches."}`,
        ),
      );
      const aliases = Object.entries(config.aliases);
      if (!name && aliases.length) {
        console.log(dim(aliases.map(([alias, model]) => `  ${alias}  ${shortModel(model)}`).join("\n")));
      }
    } else if (prompt === "/session") {
      console.log(describeSession(agent.snapshot(), `session ${sessionId.slice(0, 8)} · this one`));
    } else if (prompt.startsWith("!")) {
      await shell(prompt.slice(1).trim(), controller.signal);
    } else if (prompt === "/compact") {
      if (!(await agent.compact("manual", controller.signal))) console.log(dim("Nothing to compact."));
    } else {
      // Image and PDF paths in the prompt (dragged in from Finder) are attached so the model can see them.
      const { attachments, errors } = await attachmentsInPrompt(prompt, cwd);
      for (const a of attachments)
        console.log(dim(`⏺ Attached ${a.name}${a.pages ? ` (${a.pages} page${a.pages === 1 ? "" : "s"})` : ""}`));
      for (const e of errors) console.log(red(`⏺ ${e}`));
      // `/skill-name ...` sends the skill's instructions along with the request.
      const withSkill = await expandSkill(prompt, skills, cwd);
      if (withSkill) console.log(dim(`⏺ Using the ${prompt.slice(1).split(/\s/)[0]} skill`));
      tui.busy("Thinking");
      await agent.run(withSkill ?? prompt, controller.signal, attachments);
      // Names the session for the session list, in the background.
      void titleSession(agent, titleModel);
    }
  } catch (err) {
    console.error(red(String(err)));
  } finally {
    tui.idle();
    md?.end();
    current = undefined;
    // Steers the run never got to (it was stopped) go back into the input, ahead of anything typed since,
    // to send or edit.
    const left = agent.takeQueued().flatMap((q) => q.text.split("\n"));
    if (left.length) {
      // With nothing typed since, the last line goes back on the line being edited.
      if (!rl.line && !pendingLines.length) rl.write(left.pop()!);
      pendingLines.unshift(...left);
      console.log(dim("⏺ Put what you'd queued back in the input"));
    }
    tui.render();
  }
}

// `!command` runs a shell command without the model. See shell.ts.
async function shell(command: string, signal: AbortSignal) {
  if (!command) return console.log(dim("⏺ Type a command after the !, like !git status"));
  tui.busy("Running");
  const r = await userShell(agent, command, cwd, signal);
  if (r.output) console.log(r.output);
  if (!r.ok) console.log(red(`⏺ ${r.status}`));
}

// The last exchange of a resumed session, so it's clear where things left off.
function showRecap(session: Session, mtime: Date) {
  const turns = session.messages.filter((m) => m.role === "user");
  const lastPrompt = turns.at(-1);
  const lastReply = session.messages.findLast((m) => m.role === "assistant" && m.text.trim());
  console.log(dim(`\n⏺ Resumed session from ${ago(mtime)}, ${turns.length} turn${turns.length === 1 ? "" : "s"}. Last exchange`));
  if (lastPrompt?.role === "user") console.log(`${cyan("›")} ${lastPrompt.text.trim().split("\n")[0]}`);
  if (lastReply?.role === "assistant") {
    const lines = lastReply.text.trim().split("\n");
    const shown = lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n… ${lines.length - 8} more lines` : "");
    if (md) {
      md.push(`${shown}\n`);
      md.end();
    } else console.log(shown);
  }
}

const oneShot = args.join(" ").trim();
if (oneShot) {
  await turn(oneShot);
} else {
  // Marks the session open for the session list, and interrupted if this process dies without exiting.
  await markOpen(sessionId);
  // Full screen from here on, with the input pinned to the bottom. Readline's echo is replaced by the panel.
  // HARNESS_FULLSCREEN=0 keeps the plain line prompt.
  if (process.stdin.isTTY && process.stdout.isTTY && config.get("HARNESS_FULLSCREEN") !== "0") {
    screen.muted = true;
    tui.start();
    // The wheel scrolls, and a drag selects and copies.
    onMouse(tui.mouse);
    onKeys(menuKeys);
  }
  const home = (p: string) => p.replace(homedir(), "~");
  const loaded = `${instructions ? home(instructions.path) : "no AGENTS.md"} · ${skills.length} skills`;
  console.log(
    dim(
      `foxy-harness · ${provider.name} · ${shortModel(provider.model)} · ${cwd}\n${loaded} · session ${sessionId.slice(0, 8)}\n/model switches models, /session shows what the model sent back, /compact summarizes the conversation, /<skill> runs a skill, ← lists sessions to switch to, !command runs a shell command, shift+enter (or a trailing \\) for a newline, enter mid-turn steers it, esc or ctrl+c interrupts, ctrl+d exits`,
    ),
  );
  if (resumed) showRecap(resumed.session, resumed.mtime);
  // In raw mode ctrl+c is a keypress, so readline gets it, not the process. During a turn it aborts
  // the turn. At the prompt it clears what's typed, and on an empty prompt it exits.
  rl.on("SIGINT", () => {
    if (current) return current.abort();
    if (!rl.line && !pendingLines.length) return rl.close();
    pendingLines.length = 0;
    takeLine();
    tui.render();
  });
  process.on("SIGINT", () => current?.abort());
  rl.on("close", async () => {
    tui.stop();
    await hooks.emit({ type: "SessionEnd", sessionId });
    process.exit(0);
  });
  while (true) {
    const prompt = (await readPrompt()).trim();
    if (!prompt) continue;
    showPrompt(prompt);
    await turn(prompt);
  }
}

await hooks.emit({ type: "SessionEnd", sessionId });
rl.close();
