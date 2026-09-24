import type { ToolSpec } from "../providers/types.ts";

export type ToolContext = { cwd: string; signal?: AbortSignal };
export type ToolResult = { output: string; ok: boolean };

// A tool bundles what the model sees (spec) with the code that runs it,
// so the harness can never advertise a tool it can't execute.
export type Tool = {
  spec: ToolSpec;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};
