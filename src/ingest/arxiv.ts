/**
 * arXiv ingestion: resolve an arxiv id/URL, fetch metadata via the arXiv API,
 * and extract full text from the PDF.
 */

export interface ArxivMeta {
  arxivId: string; // canonical id, e.g. "2401.12345" (version stripped for metadata lookup)
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published: string; // YYYY-MM-DD
  absUrl: string;
  pdfUrl: string;
}

const UA = "arxiblog/0.1 (https://github.com/open330/arxiblog)";

/** Allow only https arxiv.org hosts — prevents SSRF if a URL/redirect points elsewhere. */
function assertArxivHost(u: string): URL {
  const url = new URL(u);
  if (url.protocol !== "https:") throw new Error("https URL만 허용됩니다");
  const h = url.hostname.toLowerCase();
  if (h !== "arxiv.org" && !h.endsWith(".arxiv.org")) {
    throw new Error(`arxiv.org 도메인만 허용됩니다: ${h}`);
  }
  return url;
}

/**
 * Extract a canonical arXiv id from a raw id, abs URL, or pdf URL.
 * Handles new-style (2401.12345, with optional vN) and old-style (math.GT/0309136).
 */
export function parseArxivId(input: string): string {
  const s = input.trim();

  // Full URL forms: /abs/<id>, /pdf/<id>, /html/<id>
  const urlMatch = s.match(/arxiv\.org\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?(?:[?#].*)?$/i);
  if (urlMatch) return normalizeId(urlMatch[1]);

  // arXiv:<id> prefix
  const prefixMatch = s.match(/^arxiv:\s*(.+)$/i);
  if (prefixMatch) return normalizeId(prefixMatch[1]);

  return normalizeId(s);
}

function normalizeId(raw: string): string {
  let id = raw.trim().replace(/\.pdf$/i, "");
  // New-style: 2401.12345 or 2401.12345v2
  const newStyle = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (newStyle) return id; // keep version if present
  // Old-style: archive.subclass/YYMMNNN  (e.g. math.GT/0309136, hep-th/9901001)
  const oldStyle = id.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i);
  if (oldStyle) return id;
  // Fall back to the raw token; the API will reject if invalid
  return id;
}

/** Strip a trailing version (v2) for metadata lookup, which expects the base id. */
function baseId(id: string): string {
  return id.replace(/v\d+$/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with polite backoff — arXiv's API rate-limits (429/503) frequent callers. */
async function fetchWithRetry(url: string, maxRetries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, { headers: { "User-Agent": UA } });
    if ((resp.status === 429 || resp.status === 503) && attempt < maxRetries) {
      await sleep(3000 * (attempt + 1)); // arXiv asks for ~3s spacing
      continue;
    }
    return resp;
  }
}

/** Fetch metadata from the arXiv Atom API. Parses the XML with light regex (no XML dep). */
export async function fetchArxivMeta(arxivId: string): Promise<ArxivMeta> {
  const lookup = baseId(arxivId);
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(lookup)}&max_results=1`;
  const resp = await fetchWithRetry(url);
  if (!resp.ok) throw new Error(`arXiv API error (${resp.status})`);
  const xml = await resp.text();

  const entry = sliceTag(xml, "entry");
  if (!entry) throw new Error(`arXiv 논문을 찾을 수 없습니다: ${arxivId}`);

  // arXiv returns an error entry with a specific title when the id is bad
  const title = decodeXml(stripTags(sliceTag(entry, "title") || "")).replace(/\s+/g, " ").trim();
  if (!title || /^Error$/i.test(title)) {
    throw new Error(`arXiv 논문을 찾을 수 없습니다: ${arxivId}`);
  }

  const abstract = decodeXml(stripTags(sliceTag(entry, "summary") || "")).replace(/\s+/g, " ").trim();
  const published = (sliceTag(entry, "published") || "").slice(0, 10);

  const authors: string[] = [];
  const authorRe = /<author>([\s\S]*?)<\/author>/g;
  let m: RegExpExecArray | null;
  while ((m = authorRe.exec(entry)) !== null) {
    const name = decodeXml(stripTags(sliceTag(m[1], "name") || "")).trim();
    if (name) authors.push(name);
  }

  const categories: string[] = [];
  const catRe = /<category[^>]*term="([^"]+)"/g;
  while ((m = catRe.exec(entry)) !== null) {
    if (!categories.includes(m[1])) categories.push(m[1]);
  }

  const canonicalId = arxivId; // preserve requested version
  return {
    arxivId: canonicalId,
    title,
    authors,
    abstract,
    categories,
    published,
    absUrl: `https://arxiv.org/abs/${canonicalId}`,
    pdfUrl: `https://arxiv.org/pdf/${baseId(canonicalId)}`,
  };
}

/** Download the PDF and extract its text. Returns "" on failure (abstract-only fallback). */
export async function fetchArxivFullText(pdfUrl: string): Promise<string> {
  try {
    // Follow redirects manually, re-validating each hop stays on arxiv.org (SSRF guard).
    let current = assertArxivHost(pdfUrl).href;
    let resp: Response | null = null;
    for (let i = 0; i < 5; i++) {
      resp = await fetch(current, { headers: { "User-Agent": UA }, redirect: "manual" });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) return "";
        current = assertArxivHost(new URL(loc, current).href).href;
        continue;
      }
      break;
    }
    if (!resp || !resp.ok) return "";
    const buf = Buffer.from(await resp.arrayBuffer());

    let pdfParseModule: Record<string, unknown>;
    try {
      // Import the library entry directly: pdf-parse@1.1.1's index.js runs a
      // debug branch that reads a bundled test file when imported as a module.
      pdfParseModule = await import("pdf-parse/lib/pdf-parse.js");
    } catch {
      try {
        pdfParseModule = await import("pdf-parse");
      } catch {
        return "";
      }
    }
    const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (b: Buffer) => Promise<{ text: string }>;
    const data = await pdfParse(buf);
    return cleanPdfText(data.text || "");
  } catch {
    return "";
  }
}

/** Collapse hyphenation/line noise common in PDF extraction. */
function cleanPdfText(text: string): string {
  return text
    .replace(/-\n(?=[a-z])/g, "") // join hyphenated line breaks
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── tiny XML helpers (avoid pulling a parser dependency) ──

function sliceTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
