// Line diff for display. Trims the common prefix and suffix, then runs LCS on the
// middle. Edits are usually small, so the middle stays small even in big files.

export type DiffLine = { op: " " | "-" | "+"; text: string; oldNo: number; newNo: number };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const keep = () => out.push({ op: " ", text: a[i]!, oldNo: ++i, newNo: ++j });
  const del = () => out.push({ op: "-", text: a[i]!, oldNo: ++i, newNo: j });
  const add = () => out.push({ op: "+", text: b[j]!, oldNo: i, newNo: ++j });

  while (i < pre) keep();

  const aEnd = a.length - suf;
  const bEnd = b.length - suf;
  const n = aEnd - pre;
  const m = bEnd - pre;
  if (n * m <= MAX_CELLS) {
    // lcs[x][y] = LCS length of a[pre+x..aEnd) and b[pre+y..bEnd)
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        lcs[x * w + y] = a[pre + x] === b[pre + y] ? lcs[(x + 1) * w + y + 1]! + 1 : Math.max(lcs[(x + 1) * w + y]!, lcs[x * w + y + 1]!);
      }
    }
    while (i < aEnd && j < bEnd) {
      const x = i - pre;
      const y = j - pre;
      if (a[i] === b[j]) keep();
      else if (lcs[(x + 1) * w + y]! >= lcs[x * w + y + 1]!) del();
      else add();
    }
  }
  // Too big to diff line by line (or leftovers): all removals, then all additions.
  while (i < aEnd) del();
  while (j < bEnd) add();
  while (i < a.length) keep();
  return out;
}

// Groups changed lines with `context` unchanged lines around them, like `git diff`.
export function hunks(lines: DiffLine[], context = 3): DiffLine[][] {
  const shown = Array.from({ length: lines.length }, () => false);
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) shown[k] = true;
  });

  const out: DiffLine[][] = [];
  let current: DiffLine[] | undefined;
  lines.forEach((l, i) => {
    if (!shown[i]) return void (current = undefined);
    if (!current) out.push((current = []));
    current.push(l);
  });
  return out;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  return (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n");
}
