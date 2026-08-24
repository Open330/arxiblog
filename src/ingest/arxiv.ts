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
const META_TIMEOUT_MS = 20_000;
const PDF_TIMEOUT_MS = 60_000;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 500_000;
export const PDF_PARSE_TIMEOUT_MS = 45_000;

type PdfWorkerResponse =
  | { ok: true; text: string }
  | { ok: false; error: string };

type PdfWorkerFactory = () => Worker;

/**
 * Parse untrusted PDFs outside the server's main event loop. pdf-parse/PDF.js is
 * CPU-heavy synchronous work in places, so a deadline must terminate the worker
 * instead of allowing one malformed document to stall chat/admin traffic.
 */
export function parsePdfInWorker(
  bytes: Buffer,
  timeoutMs = PDF_PARSE_TIMEOUT_MS,
  createWorker: PdfWorkerFactory = () =>
    new Worker(new URL("./pdf-worker.ts", import.meta.url).href, { type: "module" })
): Promise<string> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch {
      resolve("");
      return;
    }

    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(text.slice(0, MAX_EXTRACTED_TEXT_CHARS));
    };
    const timer = setTimeout(() => finish(""), Math.max(1, timeoutMs));

    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const message = event.data;
      finish(message?.ok && typeof message.text === "string" ? message.text : "");
    };
    worker.onerror = () => finish("");

    try {
      // Transfer the Buffer's backing allocation without copying when it is
      // already exact-sized (Buffer.concat normally is). A pooled/sliced Buffer
      // gets one exact copy so unrelated bytes are never exposed to the worker.
      const transferable =
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : Uint8Array.from(bytes).buffer;
      worker.postMessage(
        { bytes: transferable, maxChars: MAX_EXTRACTED_TEXT_CHARS },
        [transferable]
      );
    } catch {
      finish("");
    }
  });
}

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
  const invalid = (): never => {
    throw new Error(`올바른 arXiv ID 또는 URL이 아닙니다: ${s || "(빈 값)"}`);
  };

  if (!s) return invalid();

  // arXiv:<id> prefix
  const prefixMatch = s.match(/^arxiv:\s*(.+)$/i);
  if (prefixMatch) return normalizeId(prefixMatch[1]);

  // Full URL forms: /abs/<id>, /pdf/<id>, /html/<id>. Parse the host rather
  // than searching the raw string so `notarxiv.org` or a query containing an
  // arxiv-looking URL cannot be mistaken for a valid source.
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(s);
  const bareArxivUrl = /^(?:[\w-]+\.)*arxiv\.org\//i.test(s);
  if (hasScheme || bareArxivUrl) {
    let url: URL;
    try {
      url = new URL(hasScheme ? s : `https://${s}`);
    } catch {
      return invalid();
    }
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || (host !== "arxiv.org" && !host.endsWith(".arxiv.org"))) {
      return invalid();
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return invalid();
    }
    const match = path.match(/^\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/i);
    if (!match) return invalid();
    return normalizeId(match[1]);
  }

  return normalizeId(s);
}

function normalizeId(raw: string): string {
  const id = raw.trim().replace(/\.pdf$/i, "");
  // New-style: 2401.12345 or 2401.12345v2
  const newStyle = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (newStyle) return id; // keep version if present
  // Old-style: archive.subclass/YYMMNNN  (e.g. math.GT/0309136, hep-th/9901001)
  const oldStyle = id.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i);
  if (oldStyle) return id;
  throw new Error(`올바른 arXiv ID 또는 URL이 아닙니다: ${id || "(빈 값)"}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with polite backoff — arXiv's API rate-limits (429/503) and its search
 *  endpoint is often slow, so retry on 429/503 AND on network timeouts/errors. */
async function fetchWithRetry(url: string, maxRetries = 4, timeoutMs = META_TIMEOUT_MS): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((resp.status === 429 || resp.status === 503) && attempt < maxRetries) {
        try { await resp.body?.cancel(); } catch { /* best effort */ }
        await sleep(3000 * (attempt + 1)); // arXiv asks for ~3s spacing
        continue;
      }
      return resp;
    } catch (err) {
      // AbortError (timeout) or a transient network error — back off and retry.
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("arXiv 요청에 반복 실패했습니다.");
}

/** Fetch metadata from the arXiv Atom API. Parses the XML with light regex (no XML dep). */
export async function fetchArxivMeta(arxivId: string): Promise<ArxivMeta> {
  // Preserve an explicitly requested vN in both metadata and PDF lookup. This
  // keeps generated posts reproducible instead of silently mixing a v1 label
  // with the latest paper revision.
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
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
    pdfUrl: `https://arxiv.org/pdf/${canonicalId}`,
  };
}

/** Download the PDF and extract its text. Returns "" on failure (abstract-only fallback). */
export async function fetchArxivFullText(pdfUrl: string): Promise<string> {
  try {
    // Follow redirects manually, re-validating each hop stays on arxiv.org (SSRF guard).
    let current = assertArxivHost(pdfUrl).href;
    let resp: Response | null = null;
    for (let i = 0; i < 5; i++) {
      resp = await fetch(current, {
        headers: { "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) return "";
        try { await resp.body?.cancel(); } catch { /* best effort */ }
        current = assertArxivHost(new URL(loc, current).href).href;
        continue;
      }
      break;
    }
    if (!resp || !resp.ok) return "";
    const buf = await readResponseBytes(resp, MAX_PDF_BYTES);

    return cleanPdfText(await parsePdfInWorker(buf));
  } catch {
    return "";
  }
}

/** Read a response without allowing a missing/false Content-Length to bypass the cap. */
async function readResponseBytes(resp: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await resp.body?.cancel(); } catch { /* best effort */ }
    throw new Error(`PDF가 허용 크기(${maxBytes} bytes)를 초과합니다.`);
  }

  if (!resp.body) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`PDF가 허용 크기(${maxBytes} bytes)를 초과합니다.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Buffer.concat accepts Uint8Array directly; wrapping every chunk in a new
  // Buffer would copy the entire PDF once here and again during concatenation.
  return Buffer.concat(chunks, total);
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

/**
 * Fetch the most recent arXiv listing for one or more categories, newest first.
 * Returns canonical ids (URL prefix and version suffix stripped) with titles.
 * Used by the `digest` command to batch-generate posts. Goes through
 * fetchWithRetry so the API's 429/503 rate limits back off politely.
 */
export async function fetchArxivListing(
  categories: string[],
  count: number
): Promise<Array<{ arxivId: string; title: string }>> {
  const cats = categories.map((c) => c.trim()).filter(Boolean);
  if (cats.length === 0) return [];
  const max = Math.max(1, Math.floor(count));

  // e.g. "cat:cs.LG OR cat:cs.CL" — URL-encoded as a single search_query value.
  const searchQuery = cats.map((c) => `cat:${c}`).join(" OR ");
  const url =
    `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}` +
    `&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${max}`;

  // The search endpoint is slower than id_list lookups — allow a longer per-try timeout.
  const resp = await fetchWithRetry(url, 4, 45_000);
  if (!resp.ok) throw new Error(`arXiv API error (${resp.status})`);
  const xml = await resp.text();

  const results: Array<{ arxivId: string; title: string }> = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    // <id>http://arxiv.org/abs/2401.12345v2</id> → strip URL prefix and vN suffix.
    const arxivId = (sliceTag(entry, "id") || "")
      .trim()
      .replace(/^https?:\/\/arxiv\.org\/abs\//i, "")
      .replace(/v\d+$/i, "")
      .trim();
    if (!arxivId) continue;
    const title = decodeXml(stripTags(sliceTag(entry, "title") || ""))
      .replace(/\s+/g, " ")
      .trim();
    results.push({ arxivId, title });
  }
  return results;
}
