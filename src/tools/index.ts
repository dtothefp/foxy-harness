import { applyPatchTool } from "./apply-patch.ts";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit-file.ts";
import { readFileTool } from "./read-file.ts";
import type { Tool } from "./types.ts";
import { webFetchTool, webSearchTool } from "./web.ts";

// The registry. Each model family gets the edit tool it was trained on:
// Codex/GPT models use apply_patch, Claude uses exact string replace.
// Web search runs on the backend where it can (hostedTools), else here.
// Keep the order stable. Tool specs sit at the front of the prompt cache.
export function toolsFor(provider: string, hosted: string[] = []): Tool[] {
  const edit = provider === "codex" ? applyPatchTool : editFileTool;
  return [readFileTool, edit, bashTool, webFetchTool, ...(hosted.includes("web_search") ? [] : [webSearchTool])];
}
