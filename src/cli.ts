#!/usr/bin/env bun
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Agent, buildSystemPrompt } from "./agent.ts";
import { login } from "./auth/codex-oauth.ts";
import { Hooks } from "./events.ts";
import { loadConfig } from "./config.ts";
import { loadInstructions, loadSkills, watchPackageInstructions } from "./context.ts";
import { claudeProvider, resolveClaudeModel } from "./providers/claude.ts";
import { codexProvider, listModels } from "./providers/codex.ts";
import type { Provider } from "./providers/types.ts";
import { renderChanges } from "./render.ts";
import { toolsFor } from "./tools/index.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

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
  console.log(JSON.stringify(await listModels(), null, 2));
  process.exit(0);
}

const cwd = process.cwd();
const sessionId = crypto.randomUUID();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const hooks = new Hooks();

function makeProvider(): Provider {
  if (providerName === "codex") return codexProvider(modelArg ?? "gpt-5.5", sessionId);
  if (providerName !== "bedrock" && providerName !== "anthropic") {
    throw new Error(`Unknown provider "${providerName}". Use codex, bedrock or anthropic.`);
  }
  const name = modelArg ?? config.get("ANTHROPIC_MODEL") ?? config.model ?? "sonnet";
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
watchPackageInstructions(hooks, cwd, instructions, (path) => console.log(dim(`⏺ Loaded ${path}`)));

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
    console.log(`${cyan("$")} ${(e.input as { command?: string }).command ?? JSON.stringify(e.input)}`);
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
  onText: (d) => process.stdout.write(d),
  onToolStart: (name, input, changes) => {
    const args = input as { command?: string; path?: string };
    // Without --yolo the permission hook already printed the diff or command.
    if (changes) yolo && console.log(renderChanges(changes));
    else if (name === "bash") yolo && console.log(`${cyan("$")} ${args.command}`);
    else if (name === "read_file") console.log(`${cyan("⏺")} Read(${args.path})`);
    else console.log(`${cyan("⏺")} ${name}(${JSON.stringify(input).slice(0, 120)})`);
  },
  onToolEnd: (output, ok, changes) => {
    if (ok && changes) return; // the diff says it all
    const lines = output.trimEnd().split("\n");
    const shown = lines.slice(0, 12).join("\n");
    const more = lines.length > 12 ? `\n… ${lines.length - 12} more lines` : "";
    console.log(ok ? dim(shown + more) : red(shown + more));
  },
  onStep: ({ ms, firstTokenMs, usage }) => {
    const u = usage as { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
    const ttft = firstTokenMs ? `ttft ${(firstTokenMs / 1000).toFixed(1)}s · ` : "";
    console.log(dim(`\n${ttft}${(ms / 1000).toFixed(1)}s · in ${u.inputTokens ?? "?"} (cached ${u.cachedTokens ?? 0}) · out ${u.outputTokens ?? "?"}`));
  },
});

await hooks.emit({ type: "SessionStart", sessionId, cwd });

async function turn(prompt: string) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    await agent.run(prompt, controller.signal);
  } catch (err) {
    console.error(red(String(err)));
  } finally {
    process.off("SIGINT", onSigint);
  }
}

const oneShot = args.join(" ").trim();
if (oneShot) {
  await turn(oneShot);
} else {
  const home = (p: string) => p.replace(homedir(), "~");
  const loaded = `${instructions ? home(instructions.path) : "no AGENTS.md"} · ${skills.length} skills`;
  console.log(dim(`fox-harness · ${provider.name} · ${provider.model} · ${cwd}\n${loaded}\nctrl+c interrupts a turn, ctrl+d exits`));
  rl.on("close", async () => {
    await hooks.emit({ type: "SessionEnd", sessionId });
    process.exit(0);
  });
  while (true) {
    const prompt = (await rl.question(`\n${cyan("›")} `)).trim();
    if (prompt) await turn(prompt);
  }
}

await hooks.emit({ type: "SessionEnd", sessionId });
rl.close();
