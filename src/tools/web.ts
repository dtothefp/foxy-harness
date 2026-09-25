import type { Attachment } from "../providers/types.ts";
import type { Tool, ToolContext } from "./types.ts";

// web_fetch runs here for every provider. web_search runs on the provider's side where the backend has it
// (Codex, the Claude API) and here otherwise (Bedrock), through DuckDuckGo's HTML page.

const MAX_CHARS = 40_000;
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ATTACHABLE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

export const webFetchTool: Tool = {
  spec: {
    name: "web_fetch",
    description:
      "Fetch a URL and return its content as readable text. HTML is converted to text with links kept inline. " +
      "GitHub file URLs are fetched raw. Images and PDFs are attached so you can see them. " +
      `Returns up to ${MAX_CHARS} characters by default.`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "An http or https URL" },
        max_chars: { type: "number", description: `Max characters to return (default ${MAX_CHARS})` },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  hint: "fetch a URL (docs, GitHub files, APIs) as text. Use it to read pages a search turned up.",

  async run(input, ctx) {
    const { url, max_chars = MAX_CHARS } = input as { url?: unknown; max_chars?: number };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url))
      return { output: "Invalid arguments: `url` must be an http or https URL.", ok: false };
    const target = rawGitHub(url);
    const res = await get(target, ctx, { accept: "text/markdown, text/html;q=0.9, text/plain;q=0.9, */*;q=0.8" });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const head = `${res.status} ${type || "unknown type"}${res.url && res.url !== new URL(url).href ? ` (from ${res.url})` : ""}`;
    if (!res.ok) return { output: `${head}\n\n${truncate(toText(await res.text(), type), 2000)}`, ok: false };

    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return { output: `${head}\n\nToo large (${body.byteLength} bytes).`, ok: false };
    if (ATTACHABLE.test(type)) {
      const name = new URL(res.url || target).pathname.split("/").pop() || "download";
      const attachment: Attachment = { name, mediaType: type, data: Buffer.from(body).toString("base64") };
      return { output: `Attached ${name} (${type}, ${body.byteLength} bytes)`, ok: true, attachments: [attachment] };
    }
    if (type && !/^text\/|json|xml|javascript|yaml|toml|csv/.test(type))
      return { output: `${head}\n\nUnsupported content type.`, ok: false };
    return { output: `${head}\n\n${truncate(toText(new TextDecoder().decode(body), type), max_chars)}`, ok: true };
  },
};

export const webSearchTool: Tool = {
  spec: {
    name: "web_search",
    description: "Search the web. Returns the top results as title, URL and snippet. Follow up with web_fetch to read a result.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  hint: "search the web for anything current or outside your training data (docs, releases, errors). Read results with web_fetch.",

  async run(input, ctx) {
    const { query } = input as { query?: unknown };
    if (typeof query !== "string" || !query.trim()) return { output: "Invalid arguments: `query` must be a non-empty string.", ok: false };
    const res = await get(
      "https://html.duckduckgo.com/html/",
      ctx,
      { "content-type": "application/x-www-form-urlencoded" },
      `q=${encodeURIComponent(query)}`,
    );
    const html = await res.text();
    const results = parseDuckDuckGo(html);
    if (results.length)
      return {
        output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n"),
        ok: true,
      };
    // DuckDuckGo answers bots it doesn't like with a challenge page instead of results.
    if (!res.ok || /anomaly|captcha|challenge/i.test(html))
      return {
        output: `Search failed (DuckDuckGo ${res.status}, blocked or rate limited). Try again later or fetch a known URL.`,
        ok: false,
      };
    return { output: "No results.", ok: true };
  },
};

async function get(url: string, { signal }: ToolContext, headers: Record<string, string>, body?: string) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(url, {
    method: body ? "POST" : "GET",
    body,
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "user-agent": USER_AGENT, ...headers },
  });
}

// github.com/<owner>/<repo>/blob/<ref>/<path> is an HTML page around the file. The raw host serves the file.
function rawGitHub(url: string): string {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+?)(?:[?#].*)?$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

function toText(body: string, type: string): string {
  return type === "text/html" || type === "application/xhtml+xml" || (!type && /^\s*<(!doctype|html)/i.test(body))
    ? htmlToText(body)
    : body;
}

// Good enough to read docs and articles. Drops scripts, styles and page chrome, keeps headings, lists and links.
function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let s = html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`)
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const label = t.replace(/<[^>]+>/g, "").trim();
      return label && /^https?:/.test(href) && !href.includes(label) ? `[${label}](${href})` : t;
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(pre|code)[^>]*>/gi, (_, tag) => (tag.toLowerCase() === "pre" ? "\n```\n" : "`"))
    .replace(/<\/(pre|code)>/gi, (_, tag) => (tag.toLowerCase() === "pre" ? "\n```\n" : "`"))
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|tr|table|ul|ol|blockquote|dl|dt|dd|header)\b[^>]*>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `# ${decodeEntities(title).trim()}\n\n${s}` : s;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseDuckDuckGo(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  const strip = (s: string) =>
    decodeEntities(s.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
  // Each result's title link, then its snippet link before the next title.
  const parts = html.split(/<a[^>]*class="result__a"/).slice(1);
  for (const part of parts) {
    const href = part.match(/href="([^"]+)"/)?.[1];
    const title = part.match(/>([\s\S]*?)<\/a>/)?.[1];
    if (!href || !title) continue;
    // Some results link through DuckDuckGo's redirect, with the real URL in `uddg`.
    const redirect = href.match(/[?&]uddg=([^&]+)/)?.[1];
    const url = redirect ? decodeURIComponent(redirect) : decodeEntities(href);
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snippet = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    out.push({ title: strip(title), url, snippet: strip(snippet) });
    if (out.length >= 10) break;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[... ${s.length - max} more characters. Fetch with a larger max_chars to read on.]`;
}
