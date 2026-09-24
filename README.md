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

`/model <name>` switches models mid-session within the same provider (`/model gpt-5.4`, `/model opus`). `/model` alone shows the current one. `foxy-harness models` lists what your ChatGPT plan can use.

`bun link` once puts a `foxy-harness` command on your PATH, so you can run it from any repo.

The agent narrates in short lines. A dim `✻` heading for each reasoning step, one line before each batch of tool calls, and a final answer of about five lines. Bash calls show a plain-language description the model writes (`⏺ Check the current git branch`), not the command. The command and its output only show when it fails or asks permission. Other tool output is trimmed to a glimpse (the model still gets all of it).

Replies render as Markdown on a terminal (headings, bold, code, lists, quotes, links, aligned tables). Text streams line by line. Piped output stays raw.

Claude requests ask for adaptive thinking with summaries (`display: "summarized"`), so the `✻` lines show for Claude too. Newer Claude models think by default but hide it. Models older than 4.6 reject adaptive thinking, and the harness retries once without it. The step footer shows thinking tokens as `out 56 (thinking 40)` when the backend reports them.

`foxy-harness last` prints a short summary of the newest session. Provider, model, effort and thinking settings, then per step what came back (thinking shown or hidden, text length, tool calls) and token counts. `foxy-harness last <id-prefix>` picks a session. `/session` in the REPL prints the same for the current one. Inference profile ARNs are shortened so the account id doesn't show.

Drag an image into the prompt (or type its path) and it's attached, so the model sees it. `read_file` opens images too, so the model can look at a screenshot path on its own. PNG, JPEG, GIF, WebP and HEIC. On macOS, images over 1568px or 3.5 MB and HEIC photos are converted with `sips` first. macOS screenshot names have a special space before AM/PM, and paths typed with a plain space still match.

Pasting multi-line text keeps it as one prompt (bracketed paste). Enter sends it. End a line with `\` to type a newline.

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
| `HARNESS_EFFORT` | Reasoning effort. Claude takes `low`, `medium`, `high`, `xhigh`, `max` (unset is the API default, high). Codex takes `minimal` through `xhigh` (default `medium`). |
| `HARNESS_CONTEXT_WINDOW` | Context window in tokens. Default 272000 (Codex), 200000 (Claude). Compaction thresholds scale with it. |
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

## Context and compaction

Each step's footer shows how full the context window is. Two stages keep a long session under the limit.

- **Past 60%, old tool results are cleared.** All but the three newest get swapped for a stub telling the model to rerun the tool. No model call. Package instructions that rode in on a tool result are kept.
- **Past 85%, the conversation is compacted.** The whole history is replaced by a summary. Codex uses the backend's own compaction (an encrypted item the model was trained on, same as Codex CLI). Claude on the API uses Anthropic's server-side compaction beta. Bedrock doesn't have it, so the model writes the summary itself. If compaction happens mid-task, the agent carries on from the summary.

A spinner with elapsed time shows while a summary is written (about 10 to 20 seconds). Type `/compact` in the REPL to compact now. A `PreCompact` hook can return `{ block }` to skip it.

## Instructions and skills

Instructions work at two levels, monorepo style. Nothing walks up to the git root.

- **Local.** `AGENTS.md` in the launch directory, or `CLAUDE.md` if there's no `AGENTS.md`.
- **Global.** `~/.foxy-harness/AGENTS.md`, `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md` (first found). Used only when there's no local file.
- **Package.** The first time a tool reads or edits a file under a subdirectory with its own `AGENTS.md`/`CLAUDE.md`, that file is added to the tool result. It stacks with the root file. The nearest one wins, and each loads once per session.

Skills come from `.claude/skills`, `.agents/skills` and `.codex/skills`, in the launch directory and in your home directory. A local skill beats a global one with the same name. Only each skill's name, description and path go in the system prompt. The model reads `SKILL.md` with `read_file` when a task matches. Skills with `disable-model-invocation: true` are skipped. Package skills load like package instructions. The first time a tool touches a file under `packages/foo/`, skills in `packages/foo/.claude/skills` (and `.agents`, `.codex`) are added to the tool result. Nested packages stack, and a package skill can shadow a root skill with the same name.

## How it works

- `src/agent.ts` is the loop. Call the model, run tool calls, feed results back, stop when the model replies without a tool call.
- `src/events.ts` names lifecycle events after Claude Code hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop, SessionEnd. The permission prompt is just a PreToolUse handler.
- `src/context.ts` finds instruction files and skills. Package instructions arrive through a PostToolUse hook that returns `{ context }`, which the agent appends to the tool result.
- `src/compact.ts` clears old tool results and holds the fallback summarizer. Providers with server-side compaction implement `compact()`, and the result is a `summary` message that replays in the provider's native form.
- `src/tools/index.ts` is the tool registry. Each tool bundles its spec (what the model sees) with the code that runs it, so the harness can't advertise a tool it can't execute. Each model family gets the edit tool it was trained on.
- Edit tools only `plan`. They return `FileChange[]` (before/after per file). The agent passes that to the PreToolUse hook for the diff prompt, then writes it with `src/tools/changes.ts`.
- `src/tools/apply-patch.ts` is Codex's patch format, ported from `codex-rs/apply-patch`. Changes are found by context lines with a whitespace/unicode fuzz ladder, and the whole patch applies or none of it does.
- `src/tools/edit-file.ts` is exact string replace for Claude (same shape as Claude Code's Edit).
- `src/diff.ts` + `src/render.ts` draw the GitHub-style diff. `src/markdown.ts` styles streamed replies.
- `src/tools/read-file.ts` returns numbered lines, 2000 at a time, with offset/limit paging. Image files come back as an image (`src/images.ts`).
- `src/tools/bash.ts` runs each command in a fresh process group with a timeout. No persistent shell (the mini-swe-agent tradeoff).
- `src/providers/` is a thin provider interface. `codex.ts` talks to the ChatGPT Codex backend, `claude.ts` sends one Messages request shape over two transports, the Anthropic API (SSE) and Bedrock `invoke-with-response-stream` (AWS eventstream, decoded in `eventstream.ts`). Config lives in `src/config.ts`.
- `docs/codex-backend.md` has the OAuth and wire-format details.

## Auth policy

ChatGPT login in personal open-source tools is publicly OK'd by OpenAI. Anthropic doesn't allow Claude subscription login in third-party tools, so Claude goes through an API key or Bedrock.
