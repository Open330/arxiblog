/**
 * Figure ingestion: fetch an arXiv paper's rendered HTML (arxiv.org/html or the
 * ar5iv mirrors) and extract its figures — image URL + caption — with light
 * regex so no HTML-parser dependency is pulled in. Best-effort: any failure
 * yields an empty list rather than throwing, so the blog pipeline degrades
 * gracefully when a paper has no HTML rendering.
 */

export interface PaperFigure {
  imageUrl: string;
  caption: string;
  label?: string;
}

const UA = "arxiblog/0.1 (https://github.com/open330/arxiblog)";
const HTML_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 25 * 1024 * 1024; // ar5iv pages can be large; still cap.
const DEFAULT_MAX_FIGURES = 6;

/**
 * Allow only https hosts on arxiv.org / ar5iv.org (and their subdomains, which
 * covers ar5iv.labs.arxiv.org). A local variant of arxiv.ts's assertArxivHost
 * that also admits the ar5iv mirrors — prevents SSRF if a URL or redirect
 * points somewhere else.
 */
function assertFigureHost(u: string): URL {
  const url = new URL(u);
  if (url.protocol !== "https:") throw new Error("https URL만 허용됩니다");
  const h = url.hostname.toLowerCase();
  const ok =
    h === "arxiv.org" ||
    h.endsWith(".arxiv.org") ||
    h === "ar5iv.org" ||
    h.endsWith(".ar5iv.org");
  if (!ok) throw new Error(`arxiv.org / ar5iv.org 도메인만 허용됩니다: ${h}`);
  return url;
}

/** Strip a trailing version suffix (v2, v10, …) to get the base id. */
function baseArxivId(arxivId: string): string {
  return arxivId.trim().replace(/v\d+$/i, "");
}

/**
 * Fetch HTML from one candidate URL, following redirects manually and
 * re-validating each hop stays on an allowed host (SSRF guard). Returns the
 * decoded HTML plus the final resolved URL (for relative-URL resolution), or
 * null on any non-200 / empty / error.
 */
async function fetchHtml(startUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    let current = assertFigureHost(startUrl).href;
    let resp: Response | null = null;
    for (let i = 0; i < 5; i++) {
      resp = await fetch(current, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) return null;
        try { await resp.body?.cancel(); } catch { /* best effort */ }
        current = assertFigureHost(new URL(loc, current).href).href;
        continue;
      }
      break;
    }
    if (!resp || !resp.ok) return null;

    const declared = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
      try { await resp.body?.cancel(); } catch { /* best effort */ }
      return null;
    }

    const html = await resp.text();
    if (!html || !html.trim()) return null;
    if (html.length > MAX_HTML_BYTES) return null;
    return { html, finalUrl: current };
  } catch {
    return null;
  }
}

// ── tiny HTML helpers (avoid pulling a parser dependency) ──

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

/** Decode the common named + numeric HTML entities found in captions. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, "&"); // last: don't re-expand decoded ampersands
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Collapse a raw caption's markup/entities/whitespace into clean text. */
function cleanCaption(raw: string): string {
  return decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
}

/** Detect a leading figure/table label like "Figure 3", "Fig. 2", "그림 1", "Table 4", "표 2". */
function extractLabel(caption: string): string | undefined {
  const m = caption.match(/^\s*(figure|fig\.?|table|그림|표)\s*\.?\s*(\d+)/i);
  if (!m) return undefined;
  const kindRaw = m[1].toLowerCase().replace(/\.$/, "");
  const num = m[2];
  const kind =
    kindRaw === "fig" || kindRaw === "figure"
      ? "Figure"
      : kindRaw === "table"
        ? "Table"
        : kindRaw === "그림"
          ? "그림"
          : kindRaw === "표"
            ? "표"
            : kindRaw;
  return `${kind} ${num}`;
}

/** Pull the first <img>'s src (or data-src) out of a figure block. */
function extractImgSrc(figureBlock: string): string | null {
  const imgTags = figureBlock.match(/<img\b[^>]*>/gi);
  if (!imgTags) return null;
  for (const tag of imgTags) {
    const m =
      tag.match(/\bsrc\s*=\s*"([^"]+)"/i) ||
      tag.match(/\bsrc\s*=\s*'([^']+)'/i) ||
      tag.match(/\bdata-src\s*=\s*"([^"]+)"/i) ||
      tag.match(/\bdata-src\s*=\s*'([^']+)'/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/**
 * Parse `<figure>…<img src>…<figcaption>…</figcaption>…</figure>` blocks out of
 * a rendered HTML page. Relative image srcs are resolved to absolute URLs
 * against `pageUrl`. Figures lacking either an image or a caption are skipped,
 * and duplicates (by resolved imageUrl) are dropped.
 */
export function parseFigures(html: string, pageUrl: string, max: number): PaperFigure[] {
  const figures: PaperFigure[] = [];
  const seen = new Set<string>();
  const figureRe = /<figure\b[^>]*>([\s\S]*?)<\/figure>/gi;
  let m: RegExpExecArray | null;
  while ((m = figureRe.exec(html)) !== null) {
    const block = m[1];

    const capMatch = block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    if (!capMatch) continue;
    const caption = cleanCaption(capMatch[1]);
    if (!caption) continue;

    const rawSrc = extractImgSrc(block);
    if (!rawSrc) continue;

    let imageUrl: string;
    try {
      imageUrl = new URL(rawSrc, pageUrl).href;
    } catch {
      continue;
    }
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const label = extractLabel(caption);
    figures.push(label ? { imageUrl, caption, label } : { imageUrl, caption });
    if (figures.length >= max) break;
  }
  return figures;
}

/**
 * Fetch and extract up to `max` figures for an arXiv paper. Tries the official
 * HTML rendering first, then the ar5iv mirrors. Returns [] (never throws) when
 * no HTML rendering exists or nothing parses.
 */
export async function fetchArxivFigures(arxivId: string, max = DEFAULT_MAX_FIGURES): Promise<PaperFigure[]> {
  const limit = Math.max(1, Math.floor(max) || DEFAULT_MAX_FIGURES);
  const baseId = baseArxivId(arxivId);
  if (!baseId) return [];

  const encoded = encodeURIComponent(baseId).replace(/%2F/gi, "/"); // keep old-style id slashes
  const candidates = [
    `https://arxiv.org/html/${encoded}`,
    `https://ar5iv.org/html/${encoded}`,
    `https://ar5iv.labs.arxiv.org/html/${encoded}`,
  ];

  for (const url of candidates) {
    const page = await fetchHtml(url);
    if (!page) continue;
    const figures = parseFigures(page.html, page.finalUrl, limit);
    if (figures.length > 0) return figures;
  }
  return [];
}
