import { spawn } from "node:child_process";
import type { Tool } from "./types.ts";

// Stateless bash, mini-swe-agent style. Every call is a fresh process, so `cd`
// and env vars don't persist. The model prefixes them when needed.

export const bashTool: Tool = {
  spec: {
    name: "bash",
    description:
      "Run a bash command in the project directory and return combined stdout/stderr. " +
      "Each call runs in a fresh shell: cd and env vars do not persist between calls.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout_s: { type: "number", description: "Timeout in seconds (default 60)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },

  async run(input, { cwd, signal }) {
    const { command, timeout_s } = input as { command?: unknown; timeout_s?: number };
    if (typeof command !== "string") return { output: "Invalid arguments: `command` must be a string.", ok: false };
    const r = await runBash(command, { cwd, timeoutS: timeout_s, signal });
    const output = r.timedOut ? `${r.output}\n[timed out]` : `${r.output}\n[exit ${r.exitCode}]`;
    return { output, ok: r.exitCode === 0 };
  },
};

const MAX_OUTPUT = 12_000;

export async function runBash(
  command: string,
  opts: { cwd: string; timeoutS?: number; signal?: AbortSignal },
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  const timeoutMs = (opts.timeoutS ?? 60) * 1000;
  // detached puts the child in its own process group so we can kill the whole tree.
  const child = spawn("bash", ["-c", command], {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  let timedOut = false;
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  opts.signal?.addEventListener("abort", kill, { once: true });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", (err) => {
      output += String(err);
      resolve(null);
    });
  });
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", kill);

  return { output: truncate(output), exitCode, timedOut };
}

// Keep head and tail, which is where errors and summaries usually are.
function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n[... ${s.length - MAX_OUTPUT} chars truncated ...]\n\n${s.slice(-half)}`;
}
