// Lightweight fuzzy matcher for product search.
// Tolerates typos via Damerau-Levenshtein distance (insert/delete/substitute/transpose),
// with extra weight for exact substring and prefix matches.

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  const norm = normalize(s);
  return norm ? norm.split(' ') : [];
}

// Optimal-string-alignment Damerau-Levenshtein distance. Adjacent transpositions cost 1.
function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Tolerance for a single-token match. Scales with length so longer words allow more typos.
function maxEditsFor(tokenLen: number): number {
  if (tokenLen <= 3) return 1;
  if (tokenLen <= 5) return 2;
  if (tokenLen <= 8) return 3;
  return 4;
}

// Returns a non-negative relevance score (lower = better) or `null` if the item doesn't match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalize(query);
  if (!q) return 0;
  const t = normalize(text);
  if (!t) return null;

  // Exact substring hit: strong match, reward position (earlier = better).
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return idx === 0 ? -100 : -50 + idx * 0.01;
  }

  const qTokens = tokenize(q);
  const tTokens = tokenize(t);
  if (qTokens.length === 0 || tTokens.length === 0) return null;

  let total = 0;
  for (const qt of qTokens) {
    let bestRelative = Infinity;
    let bestAbsolute = Infinity;
    for (const tt of tTokens) {
      // Prefix: each extra character beyond the prefix is cheap.
      if (tt.startsWith(qt)) {
        const rel = 0;
        if (rel < bestRelative) {
          bestRelative = rel;
          bestAbsolute = 0.5;
        }
        continue;
      }
      if (qt.startsWith(tt) && qt.length - tt.length <= 2) {
        const rel = (qt.length - tt.length) / qt.length;
        if (rel < bestRelative) {
          bestRelative = rel;
          bestAbsolute = qt.length - tt.length;
        }
        continue;
      }
      // Substring inside a longer token (e.g. "mato" inside "tomato").
      if (tt.includes(qt)) {
        const rel = 0.1;
        if (rel < bestRelative) {
          bestRelative = rel;
          bestAbsolute = 0.8;
        }
        continue;
      }
      const d = damerauLevenshtein(qt, tt);
      const maxLen = Math.max(qt.length, tt.length);
      const rel = d / Math.max(qt.length, 1);
      const tolerance = maxEditsFor(Math.min(qt.length, tt.length));
      if (d <= tolerance && rel < bestRelative) {
        bestRelative = rel;
        bestAbsolute = d + (maxLen - Math.min(qt.length, tt.length)) * 0.1;
      }
    }
    if (!Number.isFinite(bestRelative)) return null; // no match for this token → reject
    total += bestAbsolute;
  }
  return total;
}

// Rank items by fuzzy relevance. Returns matches in best-first order.
export function fuzzyRank<T>(
  query: string,
  items: T[],
  getFields: (item: T) => Array<string | null | undefined>,
): T[] {
  const q = query.trim();
  if (!q) return items;

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    let best: number | null = null;
    for (const field of getFields(item)) {
      if (!field) continue;
      const s = fuzzyScore(q, field);
      if (s == null) continue;
      if (best == null || s < best) best = s;
    }
    if (best != null) scored.push({ item, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((x) => x.item);
}
