# fox-harness

A small coding agent for the terminal. TypeScript on Bun. One loop, three tools (`read_file`, an edit tool, `bash`). Runs on ChatGPT (Codex) or Claude.

## Setup

```bash
bun install
bun run login        # Sign in with ChatGPT (loopback OAuth on localhost:1455)
bun run models       # list models your plan can use
```

For Claude, set `ANTHROPIC_API_KEY` (env or `.env`). Claude subscription login isn't allowed in third-party tools.

Tokens are stored in `~/.fox-harness/auth.json` (mode 600). It's our own file, not Codex's, because refresh tokens rotate and sharing one would log Codex out.

## Use

```bash
bun src/cli.ts                       # interactive
bun src/cli.ts "fix the failing test" # one shot
bun src/cli.ts --yolo --model gpt-5.5
bun src/cli.ts --model sonnet         # opus, sonnet, haiku, or any claude-* id
```

Every edit shows a red/green diff and asks before writing. Every bash command asks too. `--yolo` skips both (diffs still print). `read_file` never asks. Type `n` to decline or any text to decline with a reason the model sees. Ctrl+C interrupts a turn.

Each session's messages save to `~/.fox-harness/sessions/<id>.json` after every step.

## How it works

- `src/agent.ts` is the loop. Call the model, run tool calls, feed results back, stop when the model replies without a tool call.
- `src/events.ts` names lifecycle events after Claude Code hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd. The permission prompt is just a PreToolUse handler.
- `src/tools/index.ts` is the tool registry. Each tool bundles its spec (what the model sees) with the code that runs it, so the harness can't advertise a tool it can't execute. Each model family gets the edit tool it was trained on.
- Edit tools only `plan`. They return `FileChange[]` (before/after per file). The agent passes that to the PreToolUse hook for the diff prompt, then writes it with `src/tools/changes.ts`.
- `src/tools/apply-patch.ts` is Codex's patch format, ported from `codex-rs/apply-patch`. Changes are found by context lines with a whitespace/unicode fuzz ladder, and the whole patch applies or none of it does.
- `src/tools/edit-file.ts` is exact string replace for Claude (same shape as Claude Code's Edit).
- `src/diff.ts` + `src/render.ts` draw the GitHub-style diff.
- `src/tools/read-file.ts` returns numbered lines, 2000 at a time, with offset/limit paging.
- `src/tools/bash.ts` runs each command in a fresh process group with a timeout. No persistent shell (the mini-swe-agent tradeoff).
- `src/providers/` is a thin provider interface. `codex.ts` talks to the ChatGPT Codex backend, `anthropic.ts` to the Messages API (with prompt-cache breakpoints), both over SSE. Bedrock and OpenRouter go here next.
- `docs/codex-backend.md` has the OAuth and wire-format details.

## Auth policy

ChatGPT login in personal open-source tools is publicly OK'd by OpenAI. Anthropic doesn't allow Claude subscription login in third-party tools, so Claude goes through an API key or Bedrock.
