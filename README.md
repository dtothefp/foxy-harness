# foxy-harness

A small coding agent for the terminal. TypeScript on Bun. One loop, a handful of tools (`read_file`, an edit tool, `bash`, `web_fetch`, `web_search`). Runs on ChatGPT (Codex) or Claude.

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

Sessions resume with Claude Code's flags. `--continue` (`-c`) picks up the newest session in the current directory. `--resume <id>` (`-r`) picks up a given one, and an id prefix is enough. `--resume` alone lists this directory's recent sessions to pick from. `--session-id <uuid>` starts a new session with that id. A resumed session keeps its provider and model and prints its last exchange. Sessions are per directory, so each git worktree has its own.

Session managers like Agent of Empires, Orca and Paseo drive Claude Code and Codex through these same flags. Point one at `foxy-harness --continue` and relaunching a pane picks up where it left off. The terminal title also follows Claude Code's. `⠋ foxy-harness` while working, `✋` while a permission question waits, `✳` when idle. Tools that read pane titles use that to show which agents need you.

`/model <name>` switches models mid-session within the same provider (`/model gpt-5.4`, `/model opus`). `/model` alone shows the current one. `foxy-harness models` lists what your ChatGPT plan can use.

Name your own models with `HARNESS_MODEL_<NAME>` env vars, in your shell or a settings.json `env` block. It's handy for Bedrock ARNs.

```bash
export HARNESS_MODEL_OPUS5="arn:aws:bedrock:<region>:<account>:application-inference-profile/<id>"
export HARNESS_MODEL_OPUS46="arn:aws:bedrock:<region>:<account>:application-inference-profile/<id>"
```

Then `/model opus46` switches mid-session, and `--model opus5` or `HARNESS_MODEL=opus5` picks one at start. Names are case-insensitive, and dashes or dots match underscores, so `sonnet-4.6` finds `HARNESS_MODEL_SONNET_4_6`. `/model` alone lists them.

`foxy-harness envrc` adds those two exports with empty values to `~/.envrc` for [direnv](https://direnv.net). `foxy-harness envrc opus5 sonnet-4.6` picks the names. Names already there are skipped. Fill in the values and run `direnv allow ~`.

`bun link` once puts a `foxy-harness` command on your PATH, so you can run it from any repo.

The agent narrates in short lines. A dim `✻` heading for each reasoning step, one line before each batch of tool calls, and a final answer of about five lines. Bash calls show a plain-language description the model writes (`⏺ Check the current git branch`), not the command. The command and its output only show when it fails or asks permission. Other tool output is trimmed to a glimpse (the model still gets all of it).

Replies render as Markdown on a terminal (headings, bold, code, lists, quotes, links, aligned tables). Text streams line by line. Piped output stays raw.

Claude requests ask for adaptive thinking with summaries (`display: "summarized"`), so the `✻` lines show for Claude too. Newer Claude models think by default but hide it. Models older than 4.6 reject adaptive thinking, and the harness retries once without it. The step footer shows thinking tokens as `out 56 (thinking 40)` when the backend reports them.

`foxy-harness last` prints a short summary of the newest session. Provider, model, effort and thinking settings, then per step what came back (thinking shown or hidden, text length, tool calls) and token counts. `foxy-harness last <id-prefix>` picks a session. `/session` in the REPL prints the same for the current one. Inference profile ARNs are shortened so the account id doesn't show.

`foxy-harness transcript <id-prefix>` prints a session as plain text (images as their names, tool calls one line each, oldest turns cut past `--max` characters, 60k by default). `foxy-harness transcript --list` shows recent sessions. The agent knows both, so in a new session you can say "pick up session 21f5" and it reads the old one through bash. Use it when a session won't resume.

When a Claude endpoint answers 200 with no reply, the harness retries once, then resends without the images from earlier turns and keeps them out for the rest of the session. If that still fails, the error shows the request size, image count and response headers.

Drag an image or PDF into the prompt (or type its path) and it's attached, so the model sees it. `read_file` opens them too, so the model can look at a screenshot path on its own. Images are PNG, JPEG, GIF, WebP and HEIC. On macOS, images over 1568px or 3.5 MB and HEIC photos are converted with `sips` first. PDFs go up to 20 MB and 100 pages, and Claude reads both the text and the page images. macOS screenshot names have a special space before AM/PM, and paths typed with a plain space still match.

`read_file` turns office documents into text. Word, RTF, ODT and web archives go through `textutil` (macOS only). Excel sheets come back as tab-separated rows and PowerPoint as text per slide. Other binary files are refused instead of read as garbage.

Web search runs where the backend can do it. Codex and the Claude API search on their side (the Responses API's `web_search` and Claude's `web_search_20250305` server tool), and the harness shows each search as it happens. Bedrock has no server-side search, so there the harness searches DuckDuckGo itself. `web_fetch` always runs locally. It turns HTML into text with links kept, fetches GitHub file pages raw, and attaches images and PDFs. It asks before each URL (a fetch can carry data out), `web_search` doesn't.

Pasting multi-line text keeps it as one prompt (bracketed paste). Enter sends it. Shift+Enter, or a `\` at the end of a line, types a newline. Shift+Enter needs a terminal that reports modified keys (xterm's modifyOtherKeys, which Ghostty, kitty and WezTerm support). Inside tmux, turn on extended keys.

```
set -g extended-keys on
set -as terminal-features ',xterm-ghostty:extkeys'
```

## Agent Client Protocol

`foxy-harness --acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) v1 on stdin and stdout, so editors and session managers that drive agents over ACP (Zed, Paseo) can run it. Sessions are the same files the terminal uses. One started in an editor resumes with `--resume <id>` and the other way round.

- Supported methods are `session/new`, `session/load` (replays the history), `session/resume`, `session/list`, `session/prompt`, `session/cancel` and `session/close`.
- Replies stream as message, thought and tool call updates. Edits carry diffs.
- Permission questions go to the client as `session/request_permission` with allow, always allow and reject. `--yolo` skips them.
- Tools run in the session's `cwd` on this machine. The client's fs and terminal methods aren't used.
- MCP servers the client passes are ignored for now.

Zed, in `settings.json`.

```json
{ "agent_servers": { "foxy-harness": { "type": "custom", "command": "foxy-harness", "args": ["--acp"] } } }
```

Agent of Empires. Run `foxy-harness aoe live` (or `foxy-harness aoe tmux`) and restart aoe. `live` opens sessions inside aoe's dashboard with your keys going to the agent (C-q back to the list, C-b b hides the sidebar). `tmux` attaches you to the agent's tmux session (C-b d back to aoe). Either way it edits aoe's `config.toml` in place (keeping a `.bak`), sets both views to the full path of `foxy-harness`, adds status rules so a waiting `apply?`, `run?` or `fetch?` shows as waiting, and makes new sessions open the same way as existing ones. It also adds a marked block to your tmux.conf (`window-size latest`, `aggressive-resize on`) so aoe's panes don't get a dotted border, and writes through a symlinked tmux.conf. Then aoe reads the config back. If aoe can't parse it, the old file goes back and you see why. Keys aoe doesn't recognize are listed. `foxy-harness aoe --check` does the checks without writing. Running it again changes nothing. By hand it's the entries below. The first is the terminal view, `agent_acp_cmd` the structured view.

```toml
[session.custom_agents]
foxy-harness = "foxy-harness"

[session.agent_acp_cmd]
foxy-harness = "foxy-harness --acp"
```

## Configuration

Nothing is hardcoded. Settings come from three places, later wins.

1. `~/.claude/settings.json` `env` block (or `$CLAUDE_CONFIG_DIR`). A machine already set up for Claude Code works as is.
2. `~/.foxy-harness/settings.json` `env` block, for harness-only overrides.
3. Real environment variables.

Values are read, never exported, so bash commands the agent runs don't see your tokens.

| Variable                                             | Meaning                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HARNESS_PROVIDER`                                   | `codex`, `bedrock` or `anthropic`. Same as `--provider`.                                                                                                           |
| `HARNESS_MODEL`                                      | Same as `--model`.                                                                                                                                                 |
| `HARNESS_MODEL_<NAME>`                               | A model name of your own. `HARNESS_MODEL_OPUS46=arn:...` makes `--model opus46` and `/model opus46` use that ARN.                                                  |
| `HARNESS_YOLO=1`                                     | Skip permission prompts. Same as `--yolo`.                                                                                                                         |
| `HARNESS_FULLSCREEN=0`                               | Plain line prompt instead of the full-screen view.                                                                                                                 |
| `HARNESS_EFFORT`                                     | Reasoning effort. Claude takes `low`, `medium`, `high`, `xhigh`, `max` (unset is the API default, high). Codex takes `minimal` through `xhigh` (default `medium`). |
| `HARNESS_WEB_SEARCH`                                 | `local` runs web search in the harness instead of on the Claude API, for orgs that turned the server tool off.                                                     |
| `HARNESS_MAX_STEPS`                                  | Model calls per turn before it stops. Unset is unlimited. A turn that hits it says so, and `continue` picks it back up.                                            |
| `HARNESS_CONTEXT_WINDOW`                             | Context window in tokens. Default 272000 (Codex), 200000 (Claude). Compaction thresholds scale with it.                                                            |
| `CLAUDE_CODE_USE_BEDROCK=1`                          | Pick Bedrock when no provider is given.                                                                                                                            |
| `ANTHROPIC_MODEL`                                    | Claude model or alias when `--model` isn't given. Falls back to the settings.json `model`, then `sonnet`.                                                          |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`        | What each alias maps to. Required on Bedrock (model id or inference profile ARN).                                                                                  |
| `ANTHROPIC_BEDROCK_BASE_URL`                         | Gateway in front of Bedrock. Default `https://bedrock-runtime.<region>.amazonaws.com`.                                                                             |
| `AWS_REGION`                                         | Region. Taken from the ARN if unset.                                                                                                                               |
| `AWS_BEARER_TOKEN_BEDROCK` or `ANTHROPIC_AUTH_TOKEN` | Sent as `Authorization: Bearer`.                                                                                                                                   |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`                    | Gateway handles AWS auth, send no AWS credentials.                                                                                                                 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`            | Direct Anthropic API.                                                                                                                                              |
| `ANTHROPIC_CUSTOM_HEADERS`                           | Extra headers, one `Name: value` per line.                                                                                                                         |

Without `--provider`, the harness picks Bedrock if `CLAUDE_CODE_USE_BEDROCK=1`, the Anthropic API if `--model` names a Claude model, else Codex.

Raw AWS access keys (SigV4 signing) aren't supported yet. Bearer tokens and gateways are.

Every edit shows a red/green diff and asks before writing. Every bash command and `web_fetch` URL asks too. `--yolo` (or `HARNESS_YOLO=1`) skips all of them (diffs still print). `read_file` and `web_search` never ask. Type `n` to decline or any text to decline with a reason the model sees. Ctrl+C interrupts a turn. At the prompt it clears what's typed, and on an empty prompt it exits.

The terminal view runs full screen, like Claude Code's fullscreen mode. Each prompt starts at the top of the screen with its reply below, and the input stays pinned to the bottom. Scroll back with the mouse wheel or PgUp/PgDn, and typing jumps back to the bottom. The view keeps its own scrollback, so select text with shift+drag (option+drag in iTerm2). On exit the whole transcript prints to the normal screen, where your terminal's scrollback has it. `HARNESS_FULLSCREEN=0` keeps a plain line prompt instead.

Start a prompt with `!` to run a shell command yourself, like Claude Code's bash mode. It runs in the project directory without asking, prints its output, and adds the command and output to the history so the model sees them with your next prompt.

You can type while a turn runs. The input stays open at the bottom, and Enter queues what you typed. It joins the same run at the next step (after the tool calls in flight finish) as another user message, so the model sees it before deciding what to do next. It doesn't start a second agent or wait for the turn to end. Esc or Ctrl+C stops the turn, and anything still queued goes back into the prompt to edit or send. Slash commands wait for the turn to finish. Over ACP a `session/prompt` sent during a turn steers it the same way and resolves when the turn ends.

Each session's messages save to `~/.foxy-harness/sessions/<id>.json` after every step, along with the directory it ran in. The banner shows the id.

## Hooks

Shell command hooks use Claude Code's format, in a `hooks` block in `~/.foxy-harness/settings.json` or `.foxy-harness/settings.json` in the launch directory. Claude Code's own settings aren't read for hooks, since those scripts expect Claude Code.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "hooks": [{ "type": "command", "command": "./scripts/check.sh" }] }]
  }
}
```

Events are SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, PreCompact, Stop and SessionEnd. Each command gets JSON on stdin with Claude Code's field names (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `prompt` and so on). Tool names are foxy-harness's own (`bash`, `read_file`, `apply_patch`, `edit_file`, `web_fetch`, `web_search`), and matchers are regexes, case-insensitive. Exit 2 blocks the prompt, tool call or compaction with stderr as the reason. Exit 0 can print JSON with `decision: "block"`, a PreToolUse `permissionDecision: "deny"`, or `hookSpecificOutput.additionalContext`. Plain stdout from UserPromptSubmit is added to the prompt. Hooks for one event run in parallel with a 60 second default timeout (`timeout` in seconds). `FOXY_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` are set to the launch directory. Notification fires with `notification_type: "permission_prompt"` when a permission question waits on you.

## Context and compaction

Each step's footer shows how full the context window is. Two stages keep a long session under the limit.

- **Past 60%, old tool results are cleared in one batch.** All but the three newest get swapped for a stub telling the model to rerun the tool. No model call. Package instructions that rode in on a tool result are kept. Editing an old message breaks the prompt cache from there on, so it only clears when that frees at least 20% of the window. That makes it a cache break every few dozen turns instead of every turn once a session is past 60%.
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
- `src/bootstrap.ts` sets up a session (provider, tools, instructions, skills, command hooks, the agent) for any frontend. `src/cli.ts` is the terminal frontend and `src/acp.ts` the ACP one. It supplies the rendering callbacks and the permission prompt.
- `src/envrc.ts` is `foxy-harness envrc`, which adds empty model exports to `~/.envrc`.
- `src/aoe.ts` is `foxy-harness aoe`, which sets up Agent of Empires' config and tmux.conf for the harness and checks the result with aoe.
- `src/events.ts` names lifecycle events after Claude Code hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop, SessionEnd. The permission prompt is just a PreToolUse handler.
- `src/context.ts` finds instruction files and skills. Package instructions arrive through a PostToolUse hook that returns `{ context }`, which the agent appends to the tool result.
- `src/compact.ts` clears old tool results and holds the fallback summarizer. Providers with server-side compaction implement `compact()`, and the result is a `summary` message that replays in the provider's native form.
- `src/tools/index.ts` is the tool registry. Each tool bundles its spec (what the model sees) with the code that runs it, so the harness can't advertise a tool it can't execute. Each model family gets the edit tool it was trained on.
- Edit tools only `plan`. They return `FileChange[]` (before/after per file). The agent passes that to the PreToolUse hook for the diff prompt, then writes it with `src/tools/changes.ts`.
- `src/tools/apply-patch.ts` is Codex's patch format, ported from `codex-rs/apply-patch`. Changes are found by context lines with a whitespace/unicode fuzz ladder, and the whole patch applies or none of it does.
- `src/tools/edit-file.ts` is exact string replace for Claude (same shape as Claude Code's Edit).
- `src/diff.ts` + `src/render.ts` draw the GitHub-style diff. `src/markdown.ts` styles streamed replies. `src/command-hooks.ts` runs shell hooks from settings.json. `src/sessions.ts` finds and loads saved sessions for `--continue` and `--resume`. `src/spinner.ts` draws the status line for quiet stretches. `src/keys.ts` decodes modified keys like Shift+Enter before readline sees them.
- `src/tools/read-file.ts` returns numbered lines, 2000 at a time, with offset/limit paging. Images and PDFs come back as attachments, office documents as text (`src/attachments.ts`).
- `src/tools/web.ts` has `web_fetch` and the local `web_search`. A provider lists its server-side tools in `hostedTools`, the registry drops the local version of those, and the provider reports each server call through `onServerTool` so the frontends show it like any other tool.
- `src/tools/bash.ts` runs each command in a fresh process group with a timeout. No persistent shell (the mini-swe-agent tradeoff).
- `src/providers/` is a thin provider interface. `codex.ts` talks to the ChatGPT Codex backend, `claude.ts` sends one Messages request shape over two transports, the Anthropic API (SSE) and Bedrock `invoke-with-response-stream` (AWS eventstream, decoded in `eventstream.ts`). Config lives in `src/config.ts`.
- `docs/codex-backend.md` has the OAuth and wire-format details.

## Auth policy

ChatGPT login in personal open-source tools is publicly OK'd by OpenAI. Anthropic doesn't allow Claude subscription login in third-party tools, so Claude goes through an API key or Bedrock.
