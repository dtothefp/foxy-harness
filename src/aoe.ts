import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `foxy-harness aoe [live|tmux] [--check]` sets up Agent of Empires for the harness in one go.
// aoe's config.toml gets the harness registered, its status rules, and how opening a session behaves.
// tmux.conf gets a small managed block so aoe's panes size right. Then aoe itself reads the file back,
// since it's the only thing that knows every key and value it accepts.
// aoe rewrites config.toml with every default filled in, so this edits it in place rather than appending,
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

export type AoeMode = "live" | "tmux";
// live keeps you in aoe's dashboard with keys going to the agent. tmux attaches you to the agent's tmux session.
const ATTACH_MODE: Record<AoeMode, string> = { live: "live_send", tmux: "tmux" };

const TMUX_START = "# >>> foxy-harness aoe >>>";
const TMUX_END = "# <<< foxy-harness aoe <<<";
const TMUX_BLOCK = `${TMUX_START}
# Managed by \`foxy-harness aoe\`. Edits between these lines are replaced on the next run.
# Size each window to the client that used it last, so aoe's panes don't show a dotted border
# when the same session is open in aoe and in another tmux client.
set -g window-size latest
setw -g aggressive-resize on
${TMUX_END}`;

type Section = { header: string; start: number; end: number };

export async function setupAoe({ mode = "live", check = false }: { mode?: AoeMode; check?: boolean } = {}): Promise<string> {
  const out: string[] = [];
  const problems: string[] = [];
  // aoe spawns the structured view without a shell, so use the full path when we can find it.
  const bin = Bun.which(NAME) ?? NAME;
  if (bin === NAME) problems.push(`${NAME} isn't on your PATH, so aoe can't start it. Run \`bun link\` in the repo.`);

  // aoe's config.
  const path = aoeConfigPath();
  const file = Bun.file(path);
  const before = (await file.exists()) ? await file.text() : "";
  if (before) {
    try {
      Bun.TOML.parse(before);
    } catch (err) {
      throw new Error(`${path} isn't valid TOML (${(err as Error).message}). Fix it or move it aside, then run this again.`);
    }
  }

  let lines = before.split("\n");
  // Old status rules go first, so they're replaced rather than doubled.
  lines = dropSections(lines, (h) => h === `[[agents.${NAME}.status_rules]]`);
  lines = setKey(lines, "session", "default_attach_mode", JSON.stringify(ATTACH_MODE[mode]));
  // New sessions open the same way as existing ones.
  lines = setKey(lines, "session", "new_session_mode", JSON.stringify("match_default"));
  lines = setKey(lines, "session.custom_agents", NAME, JSON.stringify(bin));
  lines = setKey(lines, "session.agent_acp_cmd", NAME, JSON.stringify(`${bin} --acp`));
  const after = `${lines.join("\n").trimEnd()}\n\n${STATUS_RULES}`;

  // Never hand aoe a file it can't read.
  const parsed = Bun.TOML.parse(after) as {
    session?: { default_attach_mode?: string; custom_agents?: Record<string, string>; agent_acp_cmd?: Record<string, string> };
  };
  if (parsed.session?.agent_acp_cmd?.[NAME] !== `${bin} --acp` || parsed.session.default_attach_mode !== ATTACH_MODE[mode])
    throw new Error(`Couldn't update ${path}. Edit it by hand, see the README.`);

  const aoeChanged = after !== before;
  if (!aoeChanged) out.push(`${path} already set up.`);
  else if (check) out.push(`${path} needs updating.`);
  else {
    if (before) await Bun.write(`${path}.bak`, before);
    await Bun.write(path, after);
    out.push(`Updated ${path}${before ? ` (old copy in config.toml.bak)` : ""}.`);
  }
  out.push(
    `  opening a session  ${mode === "live" ? "live, inside aoe (C-q back to the list, C-b b hides the sidebar)" : "attach to tmux (C-b d back to aoe)"}`,
    `  terminal view      ${bin}`,
    `  structured view    ${bin} --acp`,
    `  status rules       waiting on apply?, run?, fetch?`,
  );

  // tmux.conf.
  const tmux = await setupTmux(check);
  out.push(tmux.message);

  // aoe reads its own config back. A bad value anywhere makes it drop the whole file for defaults.
  // With --check that's the file as it is now.
  const verdict = checkWithAoe(check && aoeChanged ? undefined : ATTACH_MODE[mode]);
  if (verdict.error) {
    if (!check && aoeChanged) {
      if (before) await Bun.write(path, before);
      verdict.error += "\nPut the old config.toml back.";
    }
    throw new Error(verdict.error);
  }
  if (verdict.ignored) problems.push(`aoe ignores these keys in config.toml (typos or removed settings): ${verdict.ignored}`);
  out.push(verdict.note);

  if (problems.length) out.push("", ...problems.map((p) => `! ${p}`));
  if (!check && (aoeChanged || tmux.changed)) out.push("", "Restart aoe to pick it up.");
  return out.join("\n");
}

// Same rule aoe uses on macOS. The XDG directory wins if it exists, then ~/.agent-of-empires, then XDG if
// XDG_CONFIG_HOME is set.
function aoeConfigPath(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  const xdg = join(xdgHome || join(homedir(), ".config"), "agent-of-empires");
  const legacy = join(homedir(), ".agent-of-empires");
  const dir = existsSync(xdg) ? xdg : existsSync(legacy) ? legacy : xdgHome ? xdg : legacy;
  return join(dir, "config.toml");
}

function checkWithAoe(attachMode?: string): { error?: string; ignored?: string; note: string } {
  const aoe = Bun.which("aoe");
  if (!aoe) return { note: "  aoe check          skipped, aoe isn't installed" };
  const res = Bun.spawnSync([aoe, "settings", "explain", "session.default_attach_mode"], { stderr: "pipe" });
  const text = `${res.stdout.toString()}\n${res.stderr.toString()}`;
  if (/failed to parse/.test(text)) {
    const reason = text.match(/reason:\s*([\s\S]*?)\n\s*\n/)?.[1]?.trim() ?? text.trim();
    return { error: `aoe can't read config.toml, so it would ignore all of it: ${reason}`, note: "" };
  }
  if (attachMode && !text.includes(`session.default_attach_mode = "${attachMode}"`))
    return { error: `aoe didn't pick up default_attach_mode = "${attachMode}":\n${text.trim()}`, note: "" };
  const ignored = text.match(/not recognized and were ignored:\s*(.+)/)?.[1]?.trim();
  return { ignored, note: `  aoe check          config.toml reads clean${ignored ? " (with ignored keys, see below)" : ""}` };
}

async function setupTmux(check: boolean): Promise<{ changed: boolean; message: string }> {
  const xdg = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tmux", "tmux.conf");
  const home = join(homedir(), ".tmux.conf");
  const shown = existsSync(home) || !existsSync(xdg) ? home : xdg;
  // Write through a symlinked tmux.conf (dotfiles repos) rather than replacing the link.
  const path = existsSync(shown) ? realpathSync(shown) : shown;
  const before = existsSync(path) ? await Bun.file(path).text() : "";

  // Replace the block where it is so reruns don't move it, or add it at the end.
  const start = before.indexOf(TMUX_START);
  const end = before.indexOf(TMUX_END);
  const after =
    start >= 0 && end > start
      ? `${before.slice(0, start)}${TMUX_BLOCK}${before.slice(end + TMUX_END.length)}`
      : `${before.trimEnd()}${before.trim() ? "\n\n" : ""}${TMUX_BLOCK}\n`;

  if (after === before) return { changed: false, message: `${shown} already set up.` };
  if (check) return { changed: true, message: `${shown} needs the foxy-harness aoe block.` };
  await Bun.write(path, after);
  // Apply it to a running tmux server now. No server running is fine.
  const tmux = Bun.which("tmux");
  const reloaded = tmux && Bun.spawnSync([tmux, "source-file", path], { stderr: "pipe" }).exitCode === 0;
  return { changed: true, message: `Updated ${shown}${reloaded ? " and reloaded tmux" : ""} (window-size latest, aggressive-resize on).` };
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

// Sets `key = value` in [table], creating the table if needed. aoe may also write a subtable inline under
// its parent (`custom_agents = {}` under [session]). An empty one is removed in favor of the table, anything
// else is an error.
function setKey(lines: string[], table: string, key: string, value: string): string[] {
  const [parent, child] = table.split(".") as [string, string | undefined];
  const parentSection = child ? sections(lines).find((s) => s.header === `[${parent}]`) : undefined;
  if (parentSection) {
    const inline = lines.findIndex((l, i) => i > parentSection.start && i < parentSection.end && new RegExp(`^\\s*${child}\\s*=`).test(l));
    if (inline >= 0) {
      if (!/=\s*\{\s*\}\s*$/.test(lines[inline]!))
        throw new Error(`${parent}.${child} is an inline table. Move it to [${table}] and run this again.`);
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
