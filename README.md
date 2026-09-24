# foxy-harness

A small coding agent for the terminal. TypeScript on Bun. One loop, three tools (`read_file`, an edit tool, `bash`). Runs on ChatGPT (Codex) or Claude.

## Setup

```bash
bun install
bun run login        # Sign in with ChatGPT (loopback OAuth on localhost:1455)
bun run models       # list models your plan can use
```

For Claude, see Configuration below. Claude subscription login isn't allowed in third-party tools, so it's Bedrock or an API key.

Tokens are stored in `~/.foxy-harness/auth.json` (mode 600). It's our own file, not Codex's, because refresh tokens rotate and sharing one would log Codex out.

## Use

```bash
bun src/cli.ts                       # interactive
bun src/cli.ts "fix the failing test" # one shot
bun src/cli.ts --yolo --model gpt-5.5
bun src/cli.ts --model sonnet         # opus, sonnet, haiku, or any claude-* id
bun src/cli.ts --provider bedrock     # codex | bedrock | anthropic
```

`bun link` once puts a `fox-harness` command on your PATH, so you can run it from any repo.

The agent narrates in short lines. A dim `✻` heading for each reasoning step (Codex models), one line before each batch of tool calls, and a final answer of about five lines. Tool output is trimmed to a glimpse (the model still gets all of it). Failures show more.

## Configuration

Nothing is hardcoded. Settings come from three places, later wins.

1. `~/.claude/settings.json` `env` block (or `$CLAUDE_CONFIG_DIR`). A machine already set up for Claude Code works as is.
2. `~/.foxy-harness/settings.json` `env` block, for harness-only overrides.
3. Real environment variables.

Values are read, never exported, so bash commands the agent runs don't see your tokens.

| Variable | Meaning |
|---|---|
| `HARNESS_PROVIDER` | `codex`, `bedrock` or `anthropic`. Same as `--provider`. |
| `HARNESS_MODEL` | Same as `--model`. |
| `HARNESS_YOLO=1` | Skip permission prompts. Same as `--yolo`. |
| `CLAUDE_CODE_USE_BEDROCK=1` | Pick Bedrock when no provider is given. |
| `ANTHROPIC_MODEL` | Claude model or alias when `--model` isn't given. Falls back to the settings.json `model`, then `sonnet`. |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | What each alias maps to. Required on Bedrock (model id or inference profile ARN). |
| `ANTHROPIC_BEDROCK_BASE_URL` | Gateway in front of Bedrock. Default `https://bedrock-runtime.<region>.amazonaws.com`. |
| `AWS_REGION` | Region. Taken from the ARN if unset. |
| `AWS_BEARER_TOKEN_BEDROCK` or `ANTHROPIC_AUTH_TOKEN` | Sent as `Authorization: Bearer`. |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` | Gateway handles AWS auth, send no AWS credentials. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | Direct Anthropic API. |
| `ANTHROPIC_CUSTOM_HEADERS` | Extra headers, one `Name: value` per line. |

Without `--provider`, the harness picks Bedrock if `CLAUDE_CODE_USE_BEDROCK=1`, the Anthropic API if `--model` names a Claude model, else Codex.

Raw AWS access keys (SigV4 signing) aren't supported yet. Bearer tokens and gateways are.

Every edit shows a red/green diff and asks before writing. Every bash command asks too. `--yolo` (or `HARNESS_YOLO=1`) skips both (diffs still print). `read_file` never asks. Type `n` to decline or any text to decline with a reason the model sees. Ctrl+C interrupts a turn.

Each session's messages save to `~/.foxy-harness/sessions/<id>.json` after every step.

## Instructions and skills

Instructions work at two levels, monorepo style. Nothing walks up to the git root.

- **Local.** `AGENTS.md` in the launch directory, or `CLAUDE.md` if there's no `AGENTS.md`.
- **Global.** `~/.foxy-harness/AGENTS.md`, `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md` (first found). Used only when there's no local file.
- **Package.** The first time a tool reads or edits a file under a subdirectory with its own `AGENTS.md`/`CLAUDE.md`, that file is added to the tool result. It stacks with the root file. The nearest one wins, and each loads once per session.

Skills come from `.claude/skills`, `.agents/skills` and `.codex/skills`, in the launch directory and in your home directory. A local skill beats a global one with the same name. Only each skill's name, description and path go in the system prompt. The model reads `SKILL.md` with `read_file` when a task matches. Skills with `disable-model-invocation: true` are skipped. Package skills load like package instructions. The first time a tool touches a file under `packages/foo/`, skills in `packages/foo/.claude/skills` (and `.agents`, `.codex`) are added to the tool result. Nested packages stack, and a package skill can shadow a root skill with the same name.

## How it works

- `src/agent.ts` is the loop. Call the model, run tool calls, feed results back, stop when the model replies without a tool call.
- `src/events.ts` names lifecycle events after Claude Code hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd. The permission prompt is just a PreToolUse handler.
- `src/context.ts` finds instruction files and skills. Package instructions arrive through a PostToolUse hook that returns `{ context }`, which the agent appends to the tool result.
- `src/tools/index.ts` is the tool registry. Each tool bundles its spec (what the model sees) with the code that runs it, so the harness can't advertise a tool it can't execute. Each model family gets the edit tool it was trained on.
- Edit tools only `plan`. They return `FileChange[]` (before/after per file). The agent passes that to the PreToolUse hook for the diff prompt, then writes it with `src/tools/changes.ts`.
- `src/tools/apply-patch.ts` is Codex's patch format, ported from `codex-rs/apply-patch`. Changes are found by context lines with a whitespace/unicode fuzz ladder, and the whole patch applies or none of it does.
- `src/tools/edit-file.ts` is exact string replace for Claude (same shape as Claude Code's Edit).
- `src/diff.ts` + `src/render.ts` draw the GitHub-style diff.
- `src/tools/read-file.ts` returns numbered lines, 2000 at a time, with offset/limit paging.
- `src/tools/bash.ts` runs each command in a fresh process group with a timeout. No persistent shell (the mini-swe-agent tradeoff).
- `src/providers/` is a thin provider interface. `codex.ts` talks to the ChatGPT Codex backend, `claude.ts` sends one Messages request shape over two transports, the Anthropic API (SSE) and Bedrock `invoke-with-response-stream` (AWS eventstream, decoded in `eventstream.ts`). Config lives in `src/config.ts`.
- `docs/codex-backend.md` has the OAuth and wire-format details.

## Auth policy

ChatGPT login in personal open-source tools is publicly OK'd by OpenAI. Anthropic doesn't allow Claude subscription login in third-party tools, so Claude goes through an API key or Bedrock.
