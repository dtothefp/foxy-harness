import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Attachment } from "./providers/types.ts";

// Files the model sees as they are, not as text. Images and PDFs reach it two ways, read_file on the
// path or a path dragged into the prompt. Office documents are converted to text instead (extractText).
//
// Both providers cap image size (Bedrock at 3.75 MB) and Claude downscales past 1568px anyway,
// so on macOS big images and HEIC photos go through sips first. Elsewhere they're sent as is.

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
export const PDF_FILE = /\.pdf$/i;
export const ATTACHABLE = /\.(png|jpe?g|gif|webp|heic|heif|pdf)$/i;
// Documents read as text. textutil (macOS) covers Word, RTF, ODT and HTML. xlsx and pptx are zip files of XML.
export const DOCUMENT_FILE = /\.(docx?|rtf|rtfd|odt|webarchive|xlsx|pptx)$/i;

const MAX_EDGE = 1568;
const MAX_IMAGE_BYTES = 3_500_000;
// Claude takes up to 100 pages and 32 MB a request. The base64 copy is a third bigger than the file.
const MAX_PDF_BYTES = 20_000_000;
const MAX_PDF_PAGES = 100;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Rough context cost, in characters so it goes through the same estimate as text. A 1568px image is
// about 1600 tokens. A PDF page is sent as an image plus its text, call it 2000.
export const attachmentChars = (a: Attachment) => (a.pages ? a.pages * 8000 : 6400);

export async function loadAttachment(path: string): Promise<Attachment> {
  return PDF_FILE.test(path) ? loadPdf(path) : loadImage(path);
}

async function loadPdf(path: string): Promise<Attachment> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) throw new Error(`${basename(path)} is ${(bytes.length / 1e6).toFixed(1)} MB. PDFs over 20 MB can't be attached, read its text with pdftotext.`);
  const pages = pdfPages(path, bytes);
  if (pages > MAX_PDF_PAGES) throw new Error(`${basename(path)} has ${pages} pages. PDFs over ${MAX_PDF_PAGES} pages can't be attached, read its text with pdftotext.`);
  return { name: basename(path), mediaType: "application/pdf", data: bytes.toString("base64"), pages: pages || undefined };
}

// Spotlight knows the page count on macOS. Elsewhere, count page objects (misses compressed object streams).
function pdfPages(path: string, bytes: Buffer): number {
  if (process.platform === "darwin") {
    const out = Bun.spawnSync(["mdls", "-raw", "-name", "kMDItemNumberOfPages", path]).stdout.toString();
    if (/^\d+$/.test(out.trim())) return Number(out);
  }
  return bytes.toString("latin1").match(/\/Type\s*\/Page(?![a-z])/g)?.length ?? 0;
}

async function loadImage(path: string): Promise<Attachment> {
  const ext = path.split(".").pop()!.toLowerCase();
  const size = (await stat(path)).size;
  const heic = ext === "heic" || ext === "heif";
  if (process.platform === "darwin" && (heic || size > MAX_IMAGE_BYTES || (await longEdge(path)) > MAX_EDGE)) {
    const out = join(tmpdir(), `foxy-harness-${crypto.randomUUID()}.jpg`);
    const sips = Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(MAX_EDGE), path, "--out", out]);
    if (sips.exitCode !== 0) throw new Error(`Couldn't convert ${path}: ${sips.stderr.toString().trim()}`);
    const file = Bun.file(out);
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    await file.delete();
    return { name: basename(path), mediaType: "image/jpeg", data };
  }
  if (heic) throw new Error("HEIC images need macOS (sips) to convert. Export as JPEG or PNG.");
  if (size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is ${(size / 1e6).toFixed(1)} MB. The limit is 3.5 MB.`);
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
  return { name: basename(path), mediaType: TYPES[ext]!, data };
}

async function longEdge(path: string): Promise<number> {
  const out = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path]).stdout.toString();
  return Math.max(...[...out.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])), 0);
}

// Plain text from an office document.
export function extractText(path: string): string {
  const ext = path.split(".").pop()!.toLowerCase();
  if (ext === "xlsx") return xlsxText(path);
  if (ext === "pptx") return pptxText(path);
  if (process.platform !== "darwin") throw new Error(`Reading .${ext} files needs macOS (textutil). Convert it to text or PDF first.`);
  const res = Bun.spawnSync(["textutil", "-convert", "txt", "-stdout", path]);
  if (res.exitCode !== 0) throw new Error(`textutil couldn't read ${basename(path)}: ${res.stderr.toString().trim()}`);
  return res.stdout.toString();
}

function unzip(path: string, member: string): string {
  const res = Bun.spawnSync(["unzip", "-p", path, member]);
  return res.exitCode === 0 ? res.stdout.toString() : "";
}

function unzipList(path: string): string[] {
  return Bun.spawnSync(["unzip", "-Z1", path]).stdout.toString().split("\n").filter(Boolean);
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Slides in order, the text runs of each paragraph on one line.
function pptxText(path: string): string {
  const slides = unzipList(path)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return slides
    .map((name, i) => {
      const paras = unzip(path, name).split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => xmlText(m[1]!)).join(""));
      return `--- slide ${i + 1}\n${paras.filter((p) => p.trim()).join("\n")}`;
    })
    .join("\n\n");
}

// Each sheet as tab-separated rows. Shared strings are resolved, formulas show their cached value.
function xlsxText(path: string): string {
  const shared = [...unzip(path, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1]!.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => xmlText(t[1]!)).join(""),
  );
  const names = [...unzip(path, "xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => xmlText(m[1]!));
  const sheets = unzipList(path)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return sheets
    .map((name, i) => {
      const rows = [...unzip(path, name).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
        const cells: string[] = [];
        for (const c of row[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const col = colIndex(c[1]!.match(/r="([A-Z]+)/)?.[1] ?? "");
          const type = c[1]!.match(/t="(\w+)"/)?.[1];
          const v = c[2]?.match(/<v>([^<]*)<\/v>/)?.[1] ?? c[2]?.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
          cells[col >= 0 ? col : cells.length] = type === "s" ? (shared[Number(v)] ?? "") : xmlText(v);
        }
        return Array.from(cells, (c) => c ?? "").join("\t");
      });
      return `--- sheet ${names[i] ?? i + 1}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// Image and PDF paths in a prompt, as a terminal pastes them when a file is dragged in: quoted, or with
// backslash-escaped spaces. Paths that don't resolve to a file are left alone.
export async function attachmentsInPrompt(prompt: string, cwd: string): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const found = prompt.matchAll(/'([^']+)'|"([^"]+)"|((?:~|\.{0,2}\/)(?:\\.|\S)+)/g);
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  for (const m of found) {
    const raw = (m[1] ?? m[2] ?? m[3]!.replace(/\\(.)/g, "$1")).trim();
    if (!ATTACHABLE.test(raw)) continue;
    const path = await findFile(resolve(cwd, raw.replace(/^~(?=\/)/, homedir())));
    if (!path) continue;
    try {
      attachments.push(await loadAttachment(path));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { attachments, errors };
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
