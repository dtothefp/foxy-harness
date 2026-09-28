import type { CompletionRequest } from "./types.ts";

// A connection that dropped before the reply finished: a gateway or proxy closing an idle or long socket,
// a reset, a timeout. Bun's fetch throws these as TypeError or with a system error code.
const DROPPED_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ConnectionClosed",
  "ConnectionRefused",
  "UND_ERR_SOCKET",
]);

export function dropped(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || !(err instanceof Error) || err.name === "AbortError") return false;
  const code = (err as { code?: string }).code;
  return (code !== undefined && DROPPED_CODES.has(code)) || /socket|connection|network|timed out|reset/i.test(err.message);
}

// The request with its callbacks watched, so a retry knows whether any of the reply already reached the screen.
// Once text has been shown, sending again would show it twice, so the error goes to the caller instead.
export function watchShown(req: CompletionRequest): { req: CompletionRequest; shown: () => boolean } {
  let shown = false;
  const mark = <A extends unknown[]>(fn?: (...a: A) => void) =>
    fn &&
    ((...a: A) => {
      shown = true;
      fn(...a);
    });
  return { req: { ...req, onText: mark(req.onText), onServerTool: mark(req.onServerTool) }, shown: () => shown };
}

export const backoff = (attempt: number) => Bun.sleep(Math.min(1000 * 2 ** attempt, 20_000));
