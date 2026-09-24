import { applyPatchTool } from "./apply-patch.ts";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit-file.ts";
import { readFileTool } from "./read-file.ts";
import type { Tool } from "./types.ts";

// The registry. Each model family gets the edit tool it was trained on:
// Codex/GPT models use apply_patch, Claude uses exact string replace.
// Keep the order stable. Tool specs sit at the front of the prompt cache.
export function toolsFor(provider: string): Tool[] {
  const edit = provider === "anthropic" ? editFileTool : applyPatchTool;
  return [readFileTool, edit, bashTool];
}
