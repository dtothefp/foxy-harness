import { homedir } from "node:os";
import { join } from "node:path";

// `foxy-harness envrc [name...]` adds empty HARNESS_MODEL_<NAME> exports to ~/.envrc for direnv, to fill in
// with model ids or Bedrock ARNs. Names already exported there are left alone, so running it again changes nothing.
export const DEFAULT_NAMES = ["opus5", "opus46"];

export async function addModelExports(names = DEFAULT_NAMES, path = join(homedir(), ".envrc")): Promise<string> {
  const file = Bun.file(path);
  const current = (await file.exists()) ? await file.text() : "";
  const vars = [...new Set(names.map((n) => `HARNESS_MODEL_${n.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`))];
  const missing = vars.filter((v) => !new RegExp(`^\\s*(export\\s+)?${v}=`, "m").test(current));
  const shown = path.replace(homedir(), "~");
  if (!missing.length) return `${shown} already has ${vars.join(", ")}.`;

  const header = "# foxy-harness models. `/model <name>` switches, where HARNESS_MODEL_OPUS46 is `opus46`.";
  const block = [...(current.includes(header) ? [] : [header]), ...missing.map((v) => `export ${v}=""`)].join("\n");
  const sep = !current ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await Bun.write(path, `${current}${sep}${block}\n`);
  return [
    `Added ${missing.join(", ")} to ${shown}.`,
    `Fill in the values, then run \`direnv allow ${shown === "~/.envrc" ? "~" : shown}\`.`,
  ].join("\n");
}
