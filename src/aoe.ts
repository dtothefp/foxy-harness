import { homedir } from "node:os";
import { join } from "node:path";

// `foxy-harness aoe` registers the harness with Agent of Empires in ~/.agent-of-empires/config.toml.
// aoe rewrites that file with every default filled in, so this edits it in place rather than appending,
// since a duplicate key makes aoe ignore the whole file.

const NAME = "foxy-harness";
// The terminal view reads the pane to tell whether the agent needs you. These match the permission prompts.
const STATUS_RULES = `[[agents.${NAME}.status_rules]]
regex = '(apply|run|fetch)\\? *$'
status = "waiting"

[[agents.${NAME}.status_rules]]
contains = "Thinking"
status = "running"
`;

type Section = { header: string; start: number; end: number };

export async function setupAoe(): Promise<string> {
  const path = join(process.env.AGENT_OF_EMPIRES_HOME ?? join(homedir(), ".agent-of-empires"), "config.toml");
  const file = Bun.file(path);
  const before = (await file.exists()) ? await file.text() : "";
  // aoe spawns the structured view without a shell, so use the full path when we can find it.
  const bin = Bun.which(NAME) ?? NAME;

  let lines = before.split("\n");
  // Old status rules go first, so they're replaced rather than doubled.
  lines = dropSections(lines, (h) => h === `[[agents.${NAME}.status_rules]]`);
  lines = setKey(lines, "session.custom_agents", NAME, JSON.stringify(bin));
  lines = setKey(lines, "session.agent_acp_cmd", NAME, JSON.stringify(`${bin} --acp`));
  const after = `${lines.join("\n").trimEnd()}\n\n${STATUS_RULES}`;

  // Never hand aoe a file it can't read.
  const parsed = Bun.TOML.parse(after) as { session?: { custom_agents?: Record<string, string>; agent_acp_cmd?: Record<string, string> } };
  if (parsed.session?.agent_acp_cmd?.[NAME] !== `${bin} --acp`) throw new Error(`Couldn't update ${path}. Edit it by hand, see the README.`);

  if (after === before) return `${path} already set up.`;
  if (before) await Bun.write(`${path}.bak`, before);
  await Bun.write(path, after);
  return [
    `Updated ${path}${before ? ` (old copy in config.toml.bak)` : ""}.`,
    `  terminal view    ${bin}`,
    `  structured view  ${bin} --acp`,
    `  status rules     waiting on apply?, run?, fetch?`,
    `Restart aoe to pick it up.`,
  ].join("\n");
}

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*\[/.test(line)) return;
    if (out.length) out.at(-1)!.end = i;
    out.push({ header: line.trim(), start: i, end: lines.length });
  });
  return out;
}

function dropSections(lines: string[], match: (header: string) => boolean): string[] {
  const drop = sections(lines).filter((s) => match(s.header));
  return lines.filter((_, i) => !drop.some((s) => i >= s.start && i < s.end));
}

// Sets `key = value` in [table], creating the table if needed. aoe may also write the table inline under
// [session] (`custom_agents = {}`). An empty one is removed in favor of the table, anything else is an error.
function setKey(lines: string[], table: string, key: string, value: string): string[] {
  const [parent, child] = table.split(".") as [string, string];
  const parentSection = sections(lines).find((s) => s.header === `[${parent}]`);
  if (parentSection) {
    const inline = lines.findIndex((l, i) => i > parentSection.start && i < parentSection.end && new RegExp(`^\\s*${child}\\s*=`).test(l));
    if (inline >= 0) {
      if (!/=\s*\{\s*\}\s*$/.test(lines[inline]!)) throw new Error(`${parent}.${child} is an inline table. Move it to [${table}] and run this again.`);
      lines = lines.filter((_, i) => i !== inline);
    }
  }

  const section = sections(lines).find((s) => s.header === `[${table}]`);
  const entry = `${key} = ${value}`;
  if (!section) {
    const kept = trimEnd(lines);
    return [...kept, ...(kept.length ? [""] : []), `[${table}]`, entry];
  }
  const keyLine = new RegExp(`^\\s*"?${key.replace(/[-]/g, "\\-")}"?\\s*=`);
  const existing = lines.findIndex((l, i) => i > section.start && i < section.end && keyLine.test(l));
  if (existing >= 0) return lines.map((l, i) => (i === existing ? entry : l));
  // After the table's last non-blank line.
  let at = section.end;
  while (at > section.start + 1 && !lines[at - 1]!.trim()) at--;
  return [...lines.slice(0, at), entry, ...lines.slice(at)];
}

function trimEnd(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && !out.at(-1)!.trim()) out.pop();
  return out;
}
