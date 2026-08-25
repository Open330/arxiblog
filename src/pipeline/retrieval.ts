/**
 * Lightweight, dependency-free passage retrieval over a paper's extracted text.
 *
 * The in-page chat used to feed the model a fixed head/middle/tail slice of the
 * paper regardless of what the reader asked. For a long paper that silently
 * drops whole sections, so the model answers from the blog summary or guesses —
 * the single biggest accuracy risk of "an AI rewrote this paper".
 *
 * This module instead chunks the paper into passages and ranks them against the
 * reader's question with Okapi BM25 (a classic lexical scorer). No embeddings,
 * no network, fully deterministic — it stays inside the free/offline budget and
 * is easy to test. Papers are mostly English while questions are Korean, so we
 * lean on the technical tokens they share (model names, "attention", "loss",
 * numbers); when a question shares nothing scorable, callers fall back to the
 * old slice so retrieval is never worse than before.
 */

export interface Passage {
  /** Passage text, whitespace-normalized. */
  text: string;
  /** Nearest preceding section heading, if one was detected. */
  section?: string;
  /** Position in reading order (0-based). */
  index: number;
}

export interface ScoredPassage extends Passage {
  score: number;
}

export interface RetrieveOptions {
  /** Max passages to return. Default 8. */
  k?: number;
  /** Total character budget across returned passages. Default 12000. */
  budgetChars?: number;
  /** Target passage size while chunking. Default 1100. */
  chunkChars?: number;
  /**
   * Extra query terms to broaden matching, at lower weight than the question
   * itself. Papers are English but reader questions are Korean; passing the
   * post's English/technical vocabulary here lets a purely-Korean question
   * still land on the right passages. Default weight 1 vs. the question's 2.5.
   */
  expandTerms?: string[];
  /**
   * Multiply the score of passages whose section heading matches, e.g. steer a
   * "실험 결과" question toward the Experiments section. Applied after BM25.
   */
  boostSection?: { pattern: RegExp; factor: number };
}

const QUESTION_TERM_WEIGHT = 2.5;
const EXPAND_TERM_WEIGHT = 1;

// Sections that almost never answer a reader's question about the paper's
// substance; kept eligible but pushed below real content.
const BOILERPLATE_SECTION = /references|bibliography|acknowledge?ments?|appendix/i;
const BOILERPLATE_PENALTY = 0.35;

const DEFAULT_K = 8;
const DEFAULT_BUDGET = 12_000;
const DEFAULT_CHUNK = 1_100;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Minimal KO/EN stoplist: question scaffolding that would otherwise match
// section prose and drown out the technical terms that actually locate an
// answer. IDF already down-weights common words; this just removes the worst
// offenders that appear in nearly every academic paragraph.
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "were", "be", "been", "with", "as", "by", "that", "this", "these",
  "those", "it", "its", "we", "our", "they", "their", "can", "will", "would",
  "which", "what", "how", "why", "when", "does", "do", "from", "at", "not",
  // Korean question scaffolding
  "무엇", "뭐", "뭔가", "어떻게", "어떤", "왜", "설명", "알려", "논문", "이거",
  "저거", "그거", "대해", "대한", "관해", "관한", "인가요", "인가", "건가요",
  "무슨", "해줘", "해주세요", "알려줘", "부분", "내용", "의미", "뜻",
]);

/**
 * Tokenize for scoring: lowercased Latin/number runs and Hangul runs, dropping
 * 1-char tokens and stopwords. Hangul is kept as whitespace-delimited runs
 * (eojeol) — crude, but enough for the shared-term matching we rely on.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const matches = input.toLowerCase().match(/[a-z0-9]+|[가-힣]+/g);
  if (!matches) return out;
  for (const raw of matches) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

const BLANK_LINES = /\n[ \t]*\n+/;

/** Clean a passage for storage/display: rejoin PDF line-break hyphenation, then
 * collapse all whitespace (including the newlines PDF extraction litters mid-
 * sentence) so snippets read as prose and tokens aren't split across lines. */
function normalizePassage(s: string): string {
  return s
    .replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2") // "converg-\nes" -> "converges"
    .replace(/\s+/g, " ")
    .trim();
}

/** True for lines that look like a section heading (e.g. "3.2 Method", "Abstract"). */
function detectHeading(line: string): string | undefined {
  const s = line.trim();
  if (!s || s.length > 80) return undefined;
  // "1 Introduction", "3.2. Related Work" — numbered headings.
  if (/^\d+(\.\d+)*\.?\s+[A-Za-z]/.test(s)) return s.replace(/\s+/g, " ");
  // Known unnumbered headings.
  if (/^(abstract|introduction|background|related work|method(s|ology)?|approach|experiments?|results?|discussion|conclusions?|limitations?|references|appendix|acknowledge?ments?)\b/i.test(s)) {
    return s.replace(/\s+/g, " ");
  }
  return undefined;
}

/**
 * Split extracted paper text into passages, carrying the nearest section
 * heading. Paragraphs (blank-line separated) are the unit; oversized paragraphs
 * are split on sentence boundaries and tiny ones merged up to chunkChars.
 */
export function chunkText(raw: string, chunkChars: number = DEFAULT_CHUNK): Passage[] {
  const text = (raw || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];

  const passages: Passage[] = [];
  let currentSection: string | undefined;
  let buffer = "";

  const flush = () => {
    const t = normalizePassage(buffer);
    if (t.length >= 2) passages.push({ text: t, section: currentSection, index: passages.length });
    buffer = "";
  };

  for (const block of text.split(BLANK_LINES)) {
    const firstLine = block.split("\n", 1)[0] || "";
    const heading = detectHeading(firstLine);
    if (heading) {
      flush();
      currentSection = heading;
      // Keep any body that followed the heading on the same block.
      const rest = block.slice(firstLine.length).trim();
      if (!rest) continue;
      buffer = rest;
    } else {
      buffer = buffer ? `${buffer} ${block.trim()}` : block.trim();
    }

    if (buffer.length >= chunkChars) {
      // Split the overflowing buffer on sentence boundaries into ~chunkChars pieces.
      const sentences = buffer.split(/(?<=[.!?。])\s+/);
      let piece = "";
      for (const sentence of sentences) {
        if (piece && (piece.length + sentence.length + 1) > chunkChars) {
          buffer = piece;
          flush();
          piece = sentence;
        } else {
          piece = piece ? `${piece} ${sentence}` : sentence;
        }
      }
      buffer = piece;
      if (buffer.length >= chunkChars) flush();
    }
  }
  flush();
  return passages;
}

/**
 * Rank paper passages against a query with BM25 and return the best ones within
 * a character budget, ordered best-first. Returns [] when the paper is empty or
 * nothing scores above zero, so callers can fall back to a plain slice.
 */
export function retrieve(raw: string, query: string, options: RetrieveOptions = {}): ScoredPassage[] {
  const k = options.k ?? DEFAULT_K;
  const budget = options.budgetChars ?? DEFAULT_BUDGET;
  const passages = chunkText(raw, options.chunkChars ?? DEFAULT_CHUNK);
  if (passages.length === 0) return [];

  // Weighted query: the question's own terms dominate; expansion terms (e.g. the
  // post's English vocabulary) broaden matching so a Korean question can still
  // reach an English paper.
  const weights = new Map<string, number>();
  for (const t of tokenize(query)) weights.set(t, QUESTION_TERM_WEIGHT);
  for (const raw of options.expandTerms ?? []) {
    for (const t of tokenize(raw)) if (!weights.has(t)) weights.set(t, EXPAND_TERM_WEIGHT);
  }
  const queryTerms = [...weights.keys()];
  if (queryTerms.length === 0) return [];

  // Per-passage token frequencies + document frequencies for the query terms.
  const passageTokens = passages.map((p) => tokenize(p.text));
  const lengths = passageTokens.map((t) => t.length);
  const totalLen = lengths.reduce((a, b) => a + b, 0);
  const avgdl = totalLen / passages.length || 1;
  const N = passages.length;

  const df = new Map<string, number>();
  const freqs = passageTokens.map((tokens) => {
    const f = new Map<string, number>();
    for (const t of tokens) f.set(t, (f.get(t) || 0) + 1);
    for (const term of queryTerms) if (f.has(term)) df.set(term, (df.get(term) || 0) + 1);
    return f;
  });

  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const n = df.get(term) || 0;
    // Standard BM25 idf, floored at 0 so ubiquitous terms never subtract score.
    idf.set(term, Math.max(0, Math.log(1 + (N - n + 0.5) / (n + 0.5))));
  }

  const boost = options.boostSection;
  const scored: ScoredPassage[] = passages.map((p, i) => {
    const f = freqs[i];
    const dl = lengths[i] || 1;
    let score = 0;
    for (const term of queryTerms) {
      const tf = f.get(term) || 0;
      if (tf === 0) continue;
      const w = idf.get(term) || 0;
      if (w === 0) continue;
      const qw = weights.get(term) || 1;
      score += qw * w * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
    }
    if (score > 0 && p.section) {
      if (boost && boost.pattern.test(p.section)) score *= boost.factor;
      if (BOILERPLATE_SECTION.test(p.section)) score *= BOILERPLATE_PENALTY;
    }
    return { ...p, score };
  });

  // Best-first, keep only positive matches, then trim to k and the char budget.
  const ranked = scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k);
  if (ranked.length === 0) return [];

  const kept: ScoredPassage[] = [];
  let used = 0;
  for (const p of ranked) {
    if (kept.length > 0 && used + p.text.length > budget) continue;
    kept.push(p);
    used += p.text.length;
    if (used >= budget) break;
  }
  return kept;
}

/**
 * Extract lowercased English/technical tokens (model names, "attention", etc.)
 * from Korean-authored text, to expand a Korean query toward an English paper.
 */
export function latinTerms(texts: string[], max: number = 60): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of (text || "").match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || []) {
      const t = match.toLowerCase();
      if (t.length >= 3 && t.length <= 30) seen.add(t);
      if (seen.size >= max) return [...seen];
    }
  }
  return [...seen];
}

/** Trim a passage to a short, word-boundary-respecting snippet for display. */
export function snippet(text: string, maxChars: number = 240): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
