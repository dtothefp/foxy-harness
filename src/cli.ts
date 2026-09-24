#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Agent, buildSystemPrompt } from "./agent.ts";
import { login } from "./auth/codex-oauth.ts";
import { Hooks } from "./events.ts";
import { codexProvider, listModels } from "./providers/codex.ts";

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

const yolo = flag("--yolo");
const demoUnknownTool = flag("--demo-unknown-tool");
const model = option("--model") ?? process.env.HARNESS_MODEL ?? "gpt-5.5";

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

// Built-in permission hook: confirm every bash command unless --yolo.
if (!yolo) {
  hooks.on("PreToolUse", async (e) => {
    const cmd = (e.input as { command?: string }).command ?? JSON.stringify(e.input);
    const answer = (await rl.question(`${cyan("$")} ${cmd}\n${dim("run? [Y/n/reason] ")}`)).trim();
    if (answer === "" || /^y(es)?$/i.test(answer)) return;
    return { block: /^n(o)?$/i.test(answer) ? "user declined" : answer };
  });
}

const agent = new Agent({
  provider: codexProvider(model, sessionId),
  hooks,
  cwd,
  sessionId,
  system: await buildSystemPrompt(cwd),
  // Advertise a tool the harness never runs, to watch the "Unknown tool" path.
  extraTools: demoUnknownTool
    ? [
        {
          name: "read_file",
          description: "Read a file and return its contents. Prefer this over bash for reading files.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ]
    : undefined,
  onText: (d) => process.stdout.write(d),
  onToolStart: (_name, input) => {
    if (yolo) console.log(`${cyan("$")} ${(input as { command?: string }).command}`);
  },
  onToolEnd: (output, ok) => {
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
  console.log(dim(`fox-harness · ${model} · ${cwd}\nctrl+c interrupts a turn, ctrl+d exits`));
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
