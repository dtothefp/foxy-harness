#!/usr/bin/env bun
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Agent, buildSystemPrompt } from "./agent.ts";
import { login } from "./auth/codex-oauth.ts";
import { Hooks } from "./events.ts";
import { loadConfig } from "./config.ts";
import { loadInstructions, loadSkills, watchPackages } from "./context.ts";
import { attachmentsInPrompt } from "./attachments.ts";
import { ago, describeSession, findSession, type Session, shortModel } from "./inspect.ts";
import { claudeProvider, resolveClaudeModel } from "./providers/claude.ts";
import { codexProvider, listModels } from "./providers/codex.ts";
import type { Provider, Usage } from "./providers/types.ts";
import { markdownStream } from "./markdown.ts";
import { renderChanges } from "./render.ts";
import { toolsFor } from "./tools/index.ts";

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

// One line that redraws in place with elapsed seconds, for waits with no streamed output (compaction).
const spinner = (() => {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = 0;
  const elapsed = () => Math.round((performance.now() - started) / 1000);
  return {
    start(label: string) {
      started = performance.now();
      if (!process.stdout.isTTY) return console.log(dim(`⏺ ${label}…`));
      let i = 0;
      const draw = () => process.stdout.write(`\r\x1b[2K${cyan(frames[i++ % frames.length]!)} ${dim(`${label}… ${elapsed()}s`)}`);
      draw();
      timer = setInterval(draw, 100);
    },
    stop() {
      if (timer) process.stdout.write("\r\x1b[2K");
      clearInterval(timer);
      timer = undefined;
      return elapsed();
    },
  };
})();

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 1) && true : false;
};
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

const yoloFlag = flag("--yolo");
const demoUnknownTool = flag("--demo-unknown-tool");
const config = await loadConfig();
// Skip permission prompts. HARNESS_YOLO=1 makes it the default, like Claude Code's bypassPermissions mode.
const yolo = yoloFlag || config.get("HARNESS_YOLO") === "1";
const modelArg = option("--model") ?? config.get("HARNESS_MODEL");
// codex | bedrock | anthropic. Without a flag: Bedrock if Claude Code is set up for it, the Anthropic API
// if a Claude model was asked for, else Codex over the ChatGPT login.
const providerName =
  option("--provider") ??
  config.get("HARNESS_PROVIDER") ??
  (config.get("CLAUDE_CODE_USE_BEDROCK") === "1"
    ? "bedrock"
    : /^(claude|opus|sonnet|haiku|arn:)/i.test(modelArg ?? "")
      ? "anthropic"
      : "codex");

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
const sessionId = crypto.randomUUID();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const hooks = new Hooks();

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
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
const tools = toolsFor(provider.name);
const [instructions, skills] = await Promise.all([loadInstructions(cwd), loadSkills(cwd)]);
watchPackages(hooks, cwd, { instructions, skills }, (what) => console.log(dim(`⏺ Loaded ${what}`)));

async function ask(question: string) {
  const answer = (await rl.question(dim(`${question} [Y/n/reason] `))).trim();
  if (answer === "" || /^y(es)?$/i.test(answer)) return;
  return { block: /^n(o)?$/i.test(answer) ? "user declined" : answer };
}

// Built-in permission hook, skipped with --yolo. Edits show their diff first, bash shows the command.
// read_file is read-only, so it's always allowed.
if (!yolo) {
  hooks.on("PreToolUse", async (e) => {
    if (e.changes) {
      console.log(renderChanges(e.changes));
      return ask("apply?");
    }
    if (e.tool !== "bash") return;
    console.log(`${cyan("⏺")} ${describe(e.input)}\n${dim(`  $ ${bashInput(e.input).command}`)}`);
    return ask("run?");
  });
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
    const args = input as { path?: string };
    // Without --yolo the permission hook already printed the diff or command.
    if (changes) yolo && console.log(renderChanges(changes));
    else if (name === "bash") yolo && console.log(`${cyan("⏺")} ${describe(input)}`);
    else if (name === "read_file") console.log(`${cyan("⏺")} Read(${args.path})`);
    else console.log(`${cyan("⏺")} ${name}(${JSON.stringify(input).slice(0, 120)})`);
  },
  // The model reads the full result. The user sees a glimpse on success (nothing for bash) and more on
  // failure, since that's what they need to see.
  onToolEnd: (output, ok, changes, name, input) => {
    if (ok && (changes || name === "bash")) return;
    const lines = output.trimEnd().split("\n");
    if (ok && name === "read_file") return console.log(dim(`  ⎿ ${output.startsWith("Attached ") ? "attached" : `${lines.length} lines`}`));
    if (name === "bash" && yolo) console.log(dim(`  $ ${bashInput(input).command}`));
    const max = ok ? 4 : 12;
    const shown = lines.slice(0, max).map((l) => `  ${l}`).join("\n");
    const more = lines.length > max ? `\n  … ${lines.length - max} more lines` : "";
    console.log(ok ? dim(shown + more) : red(shown + more));
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
    if (info.kind === "start") return spinner.start(info.trigger === "auto" ? "Context is filling up, compacting" : "Compacting");
    const secs = spinner.stop();
    if (info.kind === "failed") return console.log(red(`⏺ Compaction failed after ${secs}s: ${info.error}`));
    const how = info.native ? "server-side" : "summary";
    console.log(dim(`⏺ Compacted conversation, ${how}, ${secs}s (~${k(info.before)} → ~${k(info.after)} tokens)`));
  },
});

await hooks.emit({ type: "SessionStart", sessionId, cwd });

// Bracketed paste. The terminal wraps pasted text in markers (readline reports them as paste-start and
// paste-end keypresses), so newlines inside a paste don't submit. Enter after the paste does.
// A trailing backslash continues the prompt on the next line.
let pasting = false;
if (process.stdin.isTTY) {
  process.stdout.write("\x1b[?2004h");
  process.on("exit", () => process.stdout.write("\x1b[?2004l"));
  process.stdin.on("keypress", (_s, key?: { name?: string }) => {
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
    process.stdout.write("\n");
    rl.setPrompt(`${cyan("›")} `);
    rl.prompt();
  });
}

async function turn(prompt: string) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
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
      for (const a of attachments) console.log(dim(`⏺ Attached ${a.name}${a.pages ? ` (${a.pages} pages)` : ""}`));
      for (const e of errors) console.log(red(`⏺ ${e}`));
      await agent.run(prompt, controller.signal, attachments);
    }
  } catch (err) {
    console.error(red(String(err)));
  } finally {
    md?.end();
    process.off("SIGINT", onSigint);
  }
}

const oneShot = args.join(" ").trim();
if (oneShot) {
  await turn(oneShot);
} else {
  const home = (p: string) => p.replace(homedir(), "~");
  const loaded = `${instructions ? home(instructions.path) : "no AGENTS.md"} · ${skills.length} skills`;
  console.log(dim(`foxy-harness · ${provider.name} · ${shortModel(provider.model)} · ${cwd}\n${loaded}\n/model switches models, /session shows what the model sent back, /compact summarizes the conversation, end a line with \\ for a newline, ctrl+c interrupts a turn, ctrl+d exits`));
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
