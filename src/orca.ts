import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// `foxy-harness orca [--as <agent>] [--check] [--remove]` makes foxy-harness pickable in Orca.
// Orca's agent picker is a fixed list of built-in agents, shown only when it finds their command on PATH,
// and there's no way to add one. So this puts a small script named after a built-in you don't use (Crush by
// default, which Orca labels Charm) in ~/.local/bin. Orca finds it, lists that agent, and launching it starts foxy-harness.
// It drops the arguments Orca passes, since those are the other agent's flags.

const NAME = "foxy-harness";
const MARKER = `# Managed by \`${NAME} orca\`.`;
// What Orca calls an agent in its picker, where that isn't the command's name.
const LABELS: Record<string, string> = { crush: "Charm" };

export async function setupOrca({
  agent = "crush",
  check = false,
  remove = false,
}: { agent?: string; check?: boolean; remove?: boolean } = {}): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new Error(`"${agent}" isn't an agent command name.`);
  const label = LABELS[agent] ?? agent;
  const dir = join(homedir(), ".local", "bin");
  const path = join(dir, agent);
  const ours = existsSync(path) && (await Bun.file(path).text()).includes(MARKER);

  if (remove) {
    if (!existsSync(path)) return `${path} isn't there. Nothing to remove.`;
    if (!ours) throw new Error(`${path} wasn't written by ${NAME} orca. Leaving it alone.`);
    if (!check) rmSync(path);
    return `${check ? "Would remove" : "Removed"} ${path}. Restart Orca and ${label} leaves the agent list.`;
  }

  // A real install of that agent would be shadowed or replaced. Pick another one.
  const found = Bun.which(agent);
  if (found && realpathSync(found) !== (existsSync(path) ? realpathSync(path) : ""))
    throw new Error(`${agent} is installed at ${found}. Use one you don't have, like \`${NAME} orca --as goose\`.`);
  if (existsSync(path) && !ours) throw new Error(`${path} exists and wasn't written by ${NAME} orca. Move it aside first.`);

  // Orca may start agents without your shell's PATH, so the script uses the full path.
  const bin = Bun.which(NAME);
  if (!bin) throw new Error(`${NAME} isn't on your PATH. Run \`bun link\` in the repo first.`);
  const script = `#!/bin/sh\n${MARKER} Orca starts this as ${agent}, and it runs ${NAME}.\nexec "${bin}"\n`;

  const out: string[] = [];
  const before = ours ? await Bun.file(path).text() : "";
  if (before === script) out.push(`${path} already set up.`);
  else if (check) out.push(`${path} needs ${ours ? "updating" : "writing"}.`);
  else {
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, script);
    chmodSync(path, 0o755);
    out.push(`Wrote ${path}, which runs ${bin}.`);
  }

  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const onPath = (process.env.PATH ?? "").split(delimiter).some((p) => p && real(p) === real(dir));
  if (!onPath) out.push(`! ${dir} isn't on your PATH. Add it in your shell rc, or Orca won't find ${agent}.`);
  out.push(
    "",
    `Quit Orca and open it again (it looks for agents at startup). Then pick ${label} under Agent when you create a`,
    `workspace. It keeps ${label}'s name and icon, and Orca's status dot won't follow the harness.`,
  );
  return out.join("\n");
}
