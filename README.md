# fox-harness

A small coding agent for the terminal. TypeScript on Bun. One loop, one bash tool.

## Setup

```bash
bun install
bun run login        # Sign in with ChatGPT (loopback OAuth on localhost:1455)
bun run models       # list models your plan can use
```

Tokens are stored in `~/.fox-harness/auth.json` (mode 600). It's our own file, not Codex's, because refresh tokens rotate and sharing one would log Codex out.

## Use

```bash
bun src/cli.ts                       # interactive
bun src/cli.ts "fix the failing test" # one shot
bun src/cli.ts --yolo --model gpt-5.5
```

Every bash command asks for confirmation unless `--yolo`. Type `n` to decline or any text to decline with a reason the model sees. Ctrl+C interrupts a turn.

Each session's messages save to `~/.fox-harness/sessions/<id>.json` after every step.

## How it works

- `src/agent.ts` is the loop. Call the model, run tool calls, feed results back, stop when the model replies without a tool call.
- `src/events.ts` names lifecycle events after Claude Code hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd. The permission prompt is just a PreToolUse handler.
- `src/tools/bash.ts` runs each command in a fresh process group with a timeout. No persistent shell (the mini-swe-agent tradeoff).
- `src/providers/` is a thin provider interface. `codex.ts` talks to the ChatGPT Codex backend over SSE. Bedrock and OpenRouter go here next.
- `docs/codex-backend.md` has the OAuth and wire-format details.

## Auth policy

ChatGPT login in personal open-source tools is publicly OK'd by OpenAI. Anthropic doesn't allow Claude subscription login in third-party tools, so Claude goes through an API key or Bedrock.
