#!/usr/bin/env bun
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Agent, buildSystemPrompt } from "./agent.ts";
import { login } from "./auth/codex-oauth.ts";
import { loadCommandHooks, registerCommandHooks } from "./command-hooks.ts";
import { Hooks } from "./events.ts";
import { loadConfig } from "./config.ts";
import { loadInstructions, loadSkills, watchPackages } from "./context.ts";
import { attachmentsInPrompt } from "./attachments.ts";
import { ago, describeSession, shortModel } from "./inspect.ts";
import { findSession, loadSession, providerFamily, type Session, sessionPath, sessionsIn, sessionTitle } from "./sessions.ts";
import { claudeProvider, resolveClaudeModel } from "./providers/claude.ts";
import { codexProvider, listModels } from "./providers/codex.ts";
import type { Provider, Usage } from "./providers/types.ts";
import { keyInput } from "./keys.ts";
import { markdownStream } from "./markdown.ts";
import { createSpinner } from "./spinner.ts";
import { renderChanges } from "./render.ts";
import { toolsFor } from "./tools/index.ts";
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

const spinner = createSpinner();

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

if (args[0] === "login") {
  await login();
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

const cwd = process.cwd();
const input = keyInput(process.stdin);
const rl = createInterface({ input, output: process.stdout, terminal: process.stdin.isTTY });
const hooks = new Hooks();

const resumed = await resumeTarget();
const sessionId = resumed?.id ?? sessionIdArg ?? crypto.randomUUID();

let modelArg = modelFlag ?? config.get("HARNESS_MODEL");
// codex | bedrock | anthropic. Without a flag: Bedrock if Claude Code is set up for it, the Anthropic API
// if a Claude model was asked for, else Codex over the ChatGPT login.
let providerName =
  providerFlag ??
  config.get("HARNESS_PROVIDER") ??
  (config.get("CLAUDE_CODE_USE_BEDROCK") === "1"
    ? "bedrock"
    : /^(claude|opus|sonnet|haiku|arn:)/i.test(modelArg ?? "")
      ? "anthropic"
      : "codex");
// A resumed session keeps its provider and model unless flags say otherwise.
if (resumed) {
  const { provider: saved, model } = resumed.session;
  if (providerFamily(saved, model) !== providerFamily(providerName)) {
    if (providerFlag) exit(`That session ran on ${saved ?? "codex"}. Its history can't move to ${providerName}.`);
    providerName = saved ?? "codex";
  }
  if (!modelFlag && (!saved || saved === providerName)) modelArg = model;
}

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
    const turns = r.session.messages.filter((m) => m.role === "user").length;
    console.log(`${cyan(String(i + 1).padStart(2))}  ${dim(`${ago(r.mtime).padEnd(12)} ${r.id.slice(0, 8)}  ${turns} turn${turns === 1 ? "" : "s"}`)}  ${sessionTitle(r.session).slice(0, 60)}`);
  });
  const answer = (await rl.question(dim(`Resume which? [1] `))).trim() || "1";
  const pick = recent[Number(answer) - 1];
  if (!pick) exit(`No session ${answer}.`);
  return pick;
}

function makeProvider(model = modelArg): Provider {
  if (providerName === "codex") return codexProvider(model ?? "gpt-5.5", sessionId, config.get("HARNESS_EFFORT"));
  if (providerName !== "bedrock" && providerName !== "anthropic") {
    throw new Error(`Unknown provider "${providerName}". Use codex, bedrock or anthropic.`);
  }
  const name = model ?? config.get("ANTHROPIC_MODEL") ?? config.model ?? "sonnet";
  return claudeProvider(providerName, resolveClaudeModel(name, providerName, config), config);
}

let provider: Provider;
try {
  provider = makeProvider();
} catch (err) {
  exit(err instanceof Error ? err.message : String(err));
}
const tools = toolsFor(provider.name);
// Command hooks from settings.json run before the built-in permission prompt, so one can deny a call first.
registerCommandHooks(hooks, await loadCommandHooks(cwd), sessionId, cwd);
const [instructions, skills] = await Promise.all([loadInstructions(cwd), loadSkills(cwd)]);
watchPackages(hooks, cwd, { instructions, skills }, (what) => console.log(dim(`⏺ Loaded ${what}`)));

// The running turn. ctrl+c aborts it, which also cancels a permission question it's waiting on.
let current: AbortController | undefined;

async function ask(question: string, tool: string) {
  spinner.waiting();
  await hooks.emit({ type: "Notification", message: `foxy-harness needs your permission to use ${tool}`, notificationType: "permission_prompt" });
  const answer = (await rl.question(dim(`${question} [Y/n/reason] `), { signal: current?.signal })).trim();
  if (answer === "" || /^y(es)?$/i.test(answer)) return;
  return { block: /^n(o)?$/i.test(answer) ? "user declined" : answer };
}

// Built-in permission hook, skipped with --yolo. Edits show their diff first, bash shows the command.
// read_file is read-only, so it's always allowed.
if (!yolo) {
  hooks.on("PreToolUse", async (e) => {
    if (e.changes) {
      console.log(renderChanges(e.changes));
      return ask("apply?", e.tool);
    }
    if (e.tool !== "bash") return;
    console.log(`${cyan("⏺")} ${describe(e.input)}\n${dim(`  $ ${bashInput(e.input).command}`)}`);
    return ask("run?", e.tool);
  });
}

// The model reads the full tool result. The user sees a glimpse on success (nothing for bash) and more on
// failure, since that's what they need to see.
function showToolEnd(output: string, ok: boolean, changes: FileChange[] | undefined, name: string, input: unknown) {
  if (ok && (changes || name === "bash")) return;
  const lines = output.trimEnd().split("\n");
  if (ok && name === "read_file") return console.log(dim(`  ⎿ ${output.startsWith("Attached ") ? "attached" : `${lines.length} lines`}`));
  if (name === "bash" && yolo) console.log(dim(`  $ ${bashInput(input).command}`));
  const max = ok ? 4 : 12;
  const shown = lines.slice(0, max).map((l) => `  ${l}`).join("\n");
  const more = lines.length > max ? `\n  … ${lines.length - max} more lines` : "";
  console.log(ok ? dim(shown + more) : red(shown + more));
}

const agent = new Agent({
  provider,
  tools,
  hooks,
  cwd,
  sessionId,
  system: buildSystemPrompt(cwd, tools, instructions, skills),
  contextWindow: Number(config.get("HARNESS_CONTEXT_WINDOW")) || undefined,
  // Advertise a tool the harness never runs, to watch the "Unknown tool" path.
  fakeTools: demoUnknownTool
    ? [
        {
          name: "web_search",
          description: "Search the web and return the top results.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ]
    : undefined,
  onText: (d) => (md ? md.push(d) : process.stdout.write(d)),
  onReasoning: (s) => console.log(dim(`\x1b[3m✻ ${s}\x1b[23m`)),
  onToolStart: (name, input, changes) => {
    spinner.busy("Running", 5000);
    const args = input as { path?: string };
    // Without --yolo the permission hook already printed the diff or command.
    if (changes) yolo && console.log(renderChanges(changes));
    else if (name === "bash") yolo && console.log(`${cyan("⏺")} ${describe(input)}`);
    else if (name === "read_file") console.log(`${cyan("⏺")} Read(${args.path})`);
    else console.log(`${cyan("⏺")} ${name}(${JSON.stringify(input).slice(0, 120)})`);
  },
  onToolEnd: (output, ok, changes, name, input) => {
    showToolEnd(output, ok, changes, name, input);
    // The model is called next.
    spinner.busy("Thinking");
  },
  onStep: ({ ms, firstTokenMs, usage }) => {
    md?.end();
    const u = usage as Usage;
    const ttft = firstTokenMs ? `ttft ${(firstTokenMs / 1000).toFixed(1)}s · ` : "";
    const used = u.inputTokens != null ? ` · ${Math.round((100 * (u.inputTokens + (u.outputTokens ?? 0))) / agent.contextWindow)}% context` : "";
    console.log(dim(`\n${ttft}${(ms / 1000).toFixed(1)}s · in ${u.inputTokens ?? "?"} (cached ${u.cachedTokens ?? 0}) · out ${u.outputTokens ?? "?"}${u.thinkingTokens ? ` (thinking ${u.thinkingTokens})` : ""}${used}`));
  },
  onCompact: (info) => {
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    if (info.kind === "clear") return console.log(dim(`⏺ Cleared old tool results (~${k(info.freedTokens)} tokens)`));
    if (info.kind === "start") return spinner.busy(info.trigger === "auto" ? "Context is filling up, compacting" : "Compacting");
    const secs = spinner.idle();
    if (info.kind === "failed") console.log(red(`⏺ Compaction failed after ${secs}s: ${info.error}`));
    else console.log(dim(`⏺ Compacted conversation, ${info.native ? "server-side" : "summary"}, ${secs}s (~${k(info.before)} → ~${k(info.after)} tokens)`));
    spinner.busy("Thinking");
  },
});

if (resumed) agent.restore(resumed.session.messages);
await hooks.emit({ type: "SessionStart", sessionId, cwd, source: resumed ? "resume" : "startup" });

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
  });
}

function readPrompt(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const onLine = (line: string) => {
      if (pasting) return void lines.push(line);
      if (line.endsWith("\\")) {
        lines.push(line.slice(0, -1));
        rl.setPrompt(dim("… "));
        return rl.prompt();
      }
      lines.push(line);
      rl.off("line", onLine);
      resolve(lines.join("\n"));
    };
    rl.on("line", onLine);
    spinner.idle();
    process.stdout.write("\n");
    rl.setPrompt(`${cyan("›")} `);
    rl.prompt();
  });
}

async function turn(prompt: string) {
  const controller = new AbortController();
  current = controller;
  try {
    if (prompt === "/model" || prompt.startsWith("/model ")) {
      const name = prompt.slice("/model".length).trim();
      if (name) agent.provider = makeProvider(name);
      console.log(dim(`⏺ ${name ? "Switched to" : "Using"} ${shortModel(agent.provider.model)} (${agent.provider.name})${name ? "" : ". /model <name> switches."}`));
    } else if (prompt === "/session") {
      console.log(describeSession(agent.snapshot(), `session ${sessionId.slice(0, 8)} · this one`));
    } else if (prompt === "/compact") {
      if (!(await agent.compact("manual", controller.signal))) console.log(dim("Nothing to compact."));
    } else {
      // Image and PDF paths in the prompt (dragged in from Finder) are attached so the model can see them.
      const { attachments, errors } = await attachmentsInPrompt(prompt, cwd);
      for (const a of attachments) console.log(dim(`⏺ Attached ${a.name}${a.pages ? ` (${a.pages} page${a.pages === 1 ? "" : "s"})` : ""}`));
      for (const e of errors) console.log(red(`⏺ ${e}`));
      spinner.busy("Thinking");
      await agent.run(prompt, controller.signal, attachments);
    }
  } catch (err) {
    console.error(red(String(err)));
  } finally {
    spinner.idle();
    md?.end();
    current = undefined;
  }
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
  const home = (p: string) => p.replace(homedir(), "~");
  const loaded = `${instructions ? home(instructions.path) : "no AGENTS.md"} · ${skills.length} skills`;
  console.log(dim(`foxy-harness · ${provider.name} · ${shortModel(provider.model)} · ${cwd}\n${loaded} · session ${sessionId.slice(0, 8)}\n/model switches models, /session shows what the model sent back, /compact summarizes the conversation, shift+enter (or a trailing \\) for a newline, ctrl+c interrupts a turn, ctrl+d exits`));
  if (resumed) showRecap(resumed.session, resumed.mtime);
  // In raw mode ctrl+c is a keypress, so readline gets it, not the process. During a turn it aborts
  // the turn. At the prompt it clears what's typed, and on an empty prompt it exits.
  rl.on("SIGINT", () => {
    if (current) return current.abort();
    if (!rl.line) return rl.close();
    rl.write(null, { ctrl: true, name: "e" });
    rl.write(null, { ctrl: true, name: "u" });
  });
  process.on("SIGINT", () => current?.abort());
  rl.on("close", async () => {
    await hooks.emit({ type: "SessionEnd", sessionId });
    process.exit(0);
  });
  while (true) {
    const prompt = (await readPrompt()).trim();
    if (prompt) await turn(prompt);
  }
}

await hooks.emit({ type: "SessionEnd", sessionId });
rl.close();
