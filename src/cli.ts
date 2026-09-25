#!/usr/bin/env bun
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { runAcp } from "./acp.ts";
import { setupAoe } from "./aoe.ts";
import { login } from "./auth/codex-oauth.ts";
import { chooseProvider, type Frontend, startSession } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { attachmentsInPrompt } from "./attachments.ts";
import { ago, describeSession, shortModel } from "./inspect.ts";
import { transcript } from "./transcript.ts";
import { findSession, loadSession, type Session, sessionFiles, sessionPath, sessionsIn, sessionTitle } from "./sessions.ts";
import { listModels } from "./providers/codex.ts";
import type { Usage } from "./providers/types.ts";
import { keyInput } from "./keys.ts";
import { markdownStream } from "./markdown.ts";
import { createSpinner } from "./spinner.ts";
import { renderChanges } from "./render.ts";
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

const spinner = createSpinner();
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
// `foxy-harness aoe` registers the harness with Agent of Empires.
if (args[0] === "aoe") {
  try {
    console.log(await setupAoe());
    process.exit(0);
  } catch (err) {
    console.error(red((err as Error).message));
    process.exit(1);
  }
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
const rl = createInterface({ input, output: process.stdout, terminal: process.stdin.isTTY });

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
    const turns = r.session.messages.filter((m) => m.role === "user").length;
    console.log(
      `${cyan(String(i + 1).padStart(2))}  ${dim(`${ago(r.mtime).padEnd(12)} ${r.id.slice(0, 8)}  ${turns} turn${turns === 1 ? "" : "s"}`)}  ${sessionTitle(r.session).slice(0, 60)}`,
    );
  });
  const answer = (await rl.question(dim(`Resume which? [1] `))).trim() || "1";
  const pick = recent[Number(answer) - 1];
  if (!pick) exit(`No session ${answer}.`);
  return pick;
}

// The running turn. ctrl+c aborts it, which also cancels a permission question it's waiting on.
let current: AbortController | undefined;

async function ask(question: string) {
  const answer = (await rl.question(dim(`${question} [Y/n/reason] `), { signal: current?.signal })).trim();
  if (answer === "" || /^y(es)?$/i.test(answer)) return;
  return { block: /^n(o)?$/i.test(answer) ? "user declined" : answer };
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
        spinner.waiting();
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
    spinner.busy("Running", 5000);
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
    spinner.busy("Thinking");
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
  onCompact: (info) => {
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    if (info.kind === "clear") return console.log(dim(`⏺ Cleared old tool results (~${k(info.freedTokens)} tokens)`));
    if (info.kind === "start") return spinner.busy(info.trigger === "auto" ? "Context is filling up, compacting" : "Compacting");
    const secs = spinner.idle();
    if (info.kind === "failed") console.log(red(`⏺ Compaction failed after ${secs}s: ${info.error}`));
    else
      console.log(
        dim(
          `⏺ Compacted conversation, ${info.native ? "server-side" : "summary"}, ${secs}s (~${k(info.before)} → ~${k(info.after)} tokens)`,
        ),
      );
    spinner.busy("Thinking");
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
const provider = agent.provider;

// A turn cut off by HARNESS_MAX_STEPS would otherwise look finished.
hooks.on("Stop", (e) => {
  if (e.reason !== "max_steps") return;
  spinner.idle();
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
      if (name) agent.provider = providerFor(name);
      console.log(
        dim(
          `⏺ ${name ? "Switched to" : "Using"} ${shortModel(agent.provider.model)} (${agent.provider.name})${name ? "" : ". /model <name> switches."}`,
        ),
      );
    } else if (prompt === "/session") {
      console.log(describeSession(agent.snapshot(), `session ${sessionId.slice(0, 8)} · this one`));
    } else if (prompt === "/compact") {
      if (!(await agent.compact("manual", controller.signal))) console.log(dim("Nothing to compact."));
    } else {
      // Image and PDF paths in the prompt (dragged in from Finder) are attached so the model can see them.
      const { attachments, errors } = await attachmentsInPrompt(prompt, cwd);
      for (const a of attachments)
        console.log(dim(`⏺ Attached ${a.name}${a.pages ? ` (${a.pages} page${a.pages === 1 ? "" : "s"})` : ""}`));
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
  console.log(
    dim(
      `foxy-harness · ${provider.name} · ${shortModel(provider.model)} · ${cwd}\n${loaded} · session ${sessionId.slice(0, 8)}\n/model switches models, /session shows what the model sent back, /compact summarizes the conversation, shift+enter (or a trailing \\) for a newline, ctrl+c interrupts a turn, ctrl+d exits`,
    ),
  );
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
