import { bashTool } from "./bash.ts";
import { readFileTool } from "./read-file.ts";
import type { Tool } from "./types.ts";

// The registry. Adding a tool = write it, add it here.
export const TOOLS: Tool[] = [bashTool, readFileTool];
