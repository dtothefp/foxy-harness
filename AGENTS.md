# fox-harness

> `CLAUDE.md` is a symlink to this file.

Bun + TypeScript coding agent. See README.md for layout.

- Run `bun run typecheck` before committing.
- Keep it small. No frameworks, no SDKs for providers unless a wire format is too painful by hand.
- New behavior around the loop goes in as a hook (`src/events.ts`) before it goes into `agent.ts`.
- Providers translate the neutral `Message` type in `src/providers/types.ts`. Don't leak wire formats into the loop.
- Always work on a feature branch and open a PR. Never commit to main.
