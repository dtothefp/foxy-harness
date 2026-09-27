import type { Agent } from "./agent.ts";
import type { Message, Provider } from "./providers/types.ts";
import { SHELL_NOTE } from "./shell.ts";

// Session titles, like Claude Code's. After the 1st, 3rd and 8th prompt a small model reads the prompts and
// the first reply and names the session in a few words, so the session list says what each one was about.
// The later passes catch sessions that opened with "hi" and got going after.

const TITLE_AT = [1, 3, 8];
const MAX_CHARS = 4000;

const SYSTEM = "You name coding sessions for a session list. You never answer or continue the session you're shown.";
const ASK = `Name the session above in 3 to 7 words, so its owner can spot it in a list later. Say what the work is about (the feature, bug, file or question). Don't answer or carry on with it. Sentence case, no quotes, no trailing period. Reply with the title only.`;

// Titles the session if it has no title yet or this turn is one of TITLE_AT. Runs after the turn and never throws, since a missing
// title only means the list falls back to the first prompt.
export async function titleSession(agent: Agent, small: () => Provider | undefined) {
  const prompts = agent.messages.filter((m) => m.role === "user" && !m.text.startsWith(SHELL_NOTE));
  // Sessions from before titles existed get one on their next turn.
  if (agent.title && !TITLE_AT.includes(prompts.length)) return;
  const excerpt = describe(agent.messages).slice(0, MAX_CHARS);
  const providers = [safe(small), agent.provider].filter((p): p is Provider => !!p);
  for (const provider of providers) {
    try {
      const text = `<session>\n${excerpt}\n</session>\n\n${ASK}`;
      const res = await provider.complete({ system: SYSTEM, messages: [{ role: "user", text }], tools: [] });
      const title = res.text
        .trim()
        .split("\n")[0]!
        .replace(/^["'`]+|["'`.]+$/g, "")
        .trim();
      if (title) return void (await agent.setTitle(title.slice(0, 80)));
    } catch {
      // Try the session's own model next.
    }
  }
}

function safe(make: () => Provider | undefined) {
  try {
    return make();
  } catch {
    return undefined;
  }
}

// The user's prompts and the first reply, as plain text.
function describe(messages: Message[]): string {
  const lines: string[] = [];
  let replied = false;
  for (const m of messages) {
    // A /skill prompt carries the whole SKILL.md ahead of the request (see expandSkill).
    const text = m.role === "user" ? m.text.replace(/^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*/, "/$1 ").trim() : "";
    if (text && !text.startsWith(SHELL_NOTE)) lines.push(`User: ${text.slice(0, 600)}`);
    if (m.role === "assistant" && m.text.trim() && !replied) {
      replied = true;
      lines.push(`Assistant: ${m.text.trim().slice(0, 800)}`);
    }
  }
  return lines.join("\n\n");
}
