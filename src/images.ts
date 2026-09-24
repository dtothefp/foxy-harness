import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Image } from "./providers/types.ts";

// Images reach the model two ways. read_file on an image path, or a path dragged into the prompt.
// Both providers cap image size (Bedrock at 3.75 MB) and Claude downscales past 1568px anyway,
// so on macOS big images and HEIC photos go through sips first. Elsewhere they're sent as is.

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
const MAX_EDGE = 1568;
const MAX_BYTES = 3_500_000;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export async function loadImage(path: string): Promise<Image> {
  const ext = path.split(".").pop()!.toLowerCase();
  const size = (await stat(path)).size;
  const heic = ext === "heic" || ext === "heif";
  if (process.platform === "darwin" && (heic || size > MAX_BYTES || (await longEdge(path)) > MAX_EDGE)) {
    const out = join(tmpdir(), `foxy-harness-${crypto.randomUUID()}.jpg`);
    const sips = Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(MAX_EDGE), path, "--out", out]);
    if (sips.exitCode !== 0) throw new Error(`Couldn't convert ${path}: ${sips.stderr.toString().trim()}`);
    const file = Bun.file(out);
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    await file.delete();
    return { name: basename(path), mediaType: "image/jpeg", data };
  }
  if (heic) throw new Error("HEIC images need macOS (sips) to convert. Export as JPEG or PNG.");
  if (size > MAX_BYTES) throw new Error(`${basename(path)} is ${(size / 1e6).toFixed(1)} MB. The limit is 3.5 MB.`);
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
  return { name: basename(path), mediaType: TYPES[ext]!, data };
}

async function longEdge(path: string): Promise<number> {
  const out = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path]).stdout.toString();
  return Math.max(...[...out.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])), 0);
}

// Image paths in a prompt, as a terminal pastes them when a file is dragged in: quoted, or with
// backslash-escaped spaces. Paths that don't resolve to a file are left alone.
export async function imagesInPrompt(prompt: string, cwd: string): Promise<{ images: Image[]; errors: string[] }> {
  const found = prompt.matchAll(/'([^']+)'|"([^"]+)"|((?:~|\.{0,2}\/)(?:\\.|\S)+)/g);
  const images: Image[] = [];
  const errors: string[] = [];
  for (const m of found) {
    const raw = (m[1] ?? m[2] ?? m[3]!.replace(/\\(.)/g, "$1")).trim();
    if (!IMAGE_FILE.test(raw)) continue;
    const path = await findFile(resolve(cwd, raw.replace(/^~(?=\/)/, homedir())));
    if (!path) continue;
    try {
      images.push(await loadImage(path));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { images, errors };
}

// macOS screenshot names have a narrow no-break space before AM/PM, which turns into a plain
// space when the path is typed or pasted. Match names with those spaces normalized.
export async function findFile(path: string): Promise<string | undefined> {
  if (await Bun.file(path).exists()) return path;
  const want = normalize(basename(path));
  const names = await readdir(dirname(path)).catch(() => []);
  const hit = names.find((n) => normalize(n) === want);
  return hit && join(dirname(path), hit);
}

const normalize = (s: string) => s.replace(/[  ]/g, " ");
