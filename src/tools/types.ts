import type { Image, ToolSpec } from "../providers/types.ts";

export type ToolContext = { cwd: string; signal?: AbortSignal };
export type ToolResult = { output: string; ok: boolean; images?: Image[] };

// One file write planned by an edit tool. `path` is relative to the working directory.
export type FileChange = {
  path: string;
  kind: "add" | "update" | "delete";
  before: string;
  after: string;
  moveTo?: string;
};

// A tool bundles what the model sees (spec) with the code that runs it,
// so the harness can never advertise a tool it can't execute.
// `hint` is the one-liner the system prompt uses to describe it.
type Base = { spec: ToolSpec; hint: string };

// Most tools just run.
export type RunTool = Base & {
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

// Edit tools only plan. They return the file changes (or throw a message for the model),
// and the agent applies them after hooks have seen the diff.
export type EditTool = Base & {
  plan(input: Record<string, unknown>, ctx: ToolContext): Promise<FileChange[]>;
};

export type Tool = RunTool | EditTool;
