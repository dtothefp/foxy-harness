// Minimal server-sent events reader. Yields each event's parsed JSON data.
export async function* sseEvents(res: Response): AsyncGenerator<any> {
  const dec = new TextDecoder();
  let buf = "";
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
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}
