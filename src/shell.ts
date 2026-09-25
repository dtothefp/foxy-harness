import type { Agent } from "./agent.ts";
import { runBash } from "./tools/bash.ts";

// `!command` at the start of a prompt, like Claude Code's bash mode. It runs in the project directory
// without asking (the user typed it) and without calling the model. The command and its output go into
// the history, so the model sees them with the next prompt.
export async function userShell(agent: Agent, command: string, cwd: string, signal: AbortSignal) {
  const r = await runBash(command, { cwd, signal, timeoutS: 600 });
  const output = r.output.trimEnd();
  const status = r.timedOut ? "timed out" : signal.aborted ? "interrupted" : `exit ${r.exitCode}`;
  await agent.note(
    `I ran a shell command myself. You can refer to it.\n<bash-input>${command}</bash-input>\n<bash-output status="${status}">\n${output}\n</bash-output>`,
  );
  return { output, status, ok: r.exitCode === 0 };
}
