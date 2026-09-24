// AWS event stream decoder (application/vnd.amazon.eventstream), what Bedrock streams back.
// Frame: [total len u32][headers len u32][prelude crc u32][headers][payload][message crc u32].
// Bedrock's payload is {"bytes": base64}, which decodes to the same JSON events the Anthropic API sends over SSE.
// CRCs aren't checked. TLS already covers integrity.

export async function* eventStreamEvents(res: Response): AsyncGenerator<any> {
  let buf: Uint8Array = new Uint8Array(0);
  const text = new TextDecoder();

  for await (const chunk of res.body!) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;

    while (buf.length >= 12) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const total = view.getUint32(0);
      const headersLen = view.getUint32(4);
      if (buf.length < total) break;

      const headers = parseHeaders(buf.subarray(12, 12 + headersLen));
      const payload = text.decode(buf.subarray(12 + headersLen, total - 4));
      buf = buf.subarray(total);

      if (headers[":message-type"] !== "event") {
        throw new Error(`bedrock ${headers[":exception-type"] ?? headers[":error-code"] ?? "error"}: ${payload}`);
      }
      const { bytes } = JSON.parse(payload) as { bytes?: string };
      if (bytes) yield JSON.parse(Buffer.from(bytes, "base64").toString("utf8"));
    }
  }
}

// Header: [name len u8][name][type u8][value]. Only string values matter here; others are skipped.
const FIXED_SIZE: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

function parseHeaders(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  const out: Record<string, string> = {};
  let i = 0;
  while (i < bytes.length) {
    const nameLen = view.getUint8(i++);
    const name = text.decode(bytes.subarray(i, i + nameLen));
    i += nameLen;
    const type = view.getUint8(i++);
    if (type === 6 || type === 7) {
      const len = view.getUint16(i);
      i += 2;
      if (type === 7) out[name] = text.decode(bytes.subarray(i, i + len));
      i += len;
    } else {
      i += FIXED_SIZE[type] ?? 0;
    }
  }
  return out;
}
