// Minimal server-sent events reader. Yields each event's parsed JSON data.
export async function* sseEvents(res: Response): AsyncGenerator<any> {
  const dec = new TextDecoder();
  let buf = "";
  let events = 0;
  for await (const chunk of res.body!) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        events++;
        yield JSON.parse(data);
      }
    }
  }
  // A proxy can answer 200 with a plain error body. Show it rather than an empty reply.
  if (!events && buf.trim()) throw new Error(`not an event stream: ${buf.trim().slice(0, 2000)}`);
}
