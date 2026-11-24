// Small keyword retriever for knowledge bases too big to put in every prompt.

export const INLINE_KB_LIMIT_CHARS = 30_000;

export function chunkKnowledge(text: string, maxChars = 900): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) { chunks.push(cur); cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'you', 'your', 'i', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'it', 'how', 'what', 'much', 'can', 'does', 'with', 'my', 'me']);
const words = (s: string) => s.toLowerCase().match(/[a-z0-9$]+/g)?.filter((w) => !STOP.has(w) && w.length > 1) ?? [];

export function searchChunks(chunks: string[], query: string, k = 3): string[] {
  const q = new Set(words(query));
  if (q.size === 0) return [];
  return chunks
    .map((c) => ({ c, score: words(c).reduce((n, w) => n + (q.has(w) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}
