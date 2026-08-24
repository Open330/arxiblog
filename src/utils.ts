/**
 * Shared utility functions used across arxiblog.
 */

/** Escape HTML special characters to prevent XSS in template output. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip markdown code fences (```json ... ```) that LLMs often wrap around output. */
export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  // Remove a leading ```json or ``` fence
  s = s.replace(/^```(?:json|markdown|md)?\s*\n?/i, "");
  // Remove a trailing ``` fence
  s = s.replace(/\n?```\s*$/i, "");
  return s.trim();
}

/**
 * Parse JSON from an LLM response that may be wrapped in prose or code fences.
 * Falls back to extracting the first {...} or [...] block.
 */
export function parseLlmJson<T = unknown>(raw: string): T {
  const cleaned = stripJsonFences(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Extract the first balanced JSON value, tracking string/escape state so that
    // braces inside string values (or trailing prose like ":}") don't fool us.
    const objStart = cleaned.indexOf("{");
    const arrStart = cleaned.indexOf("[");
    const candidates = [objStart, arrStart].filter((i) => i !== -1);
    if (candidates.length === 0) throw new Error("No JSON found in LLM response");
    const start = Math.min(...candidates);
    const open = cleaned[start];
    const close = open === "{" ? "}" : "]";

    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1)) as T;
      }
    }
    throw new Error("Unterminated JSON in LLM response");
  }
}

/** Split a comma-separated category string into trimmed, non-empty parts. */
export function splitCategories(s: string | undefined | null): string[] {
  return (s || "").split(",").map((c) => c.trim()).filter(Boolean);
}

/** Turn an arbitrary string into a URL-safe slug (keeps Korean characters). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "post";
}

/**
 * Estimate reading time in minutes for mixed Korean/English markdown.
 * CJK is counted by characters (~500/min); Latin text by words (~220 wpm).
 * The two are counted on disjoint slices so Korean isn't double-counted.
 */
export function estimateReadingMinutes(text: string): number {
  const cjk = (text.match(/[ㄱ-ㆎ가-힣぀-ヿ一-鿿]/g) || []).length;
  const latin = text.replace(/[ㄱ-ㆎ가-힣぀-ヿ一-鿿]/g, " ");
  const words = (latin.match(/[A-Za-z0-9]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 500 + words / 220));
}

/**
 * Keep evidence from the beginning, middle, and conclusion of a long paper.
 * A simple leading slice systematically drops results and limitations.
 */
export function representativeText(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit === 0) return "";

  const marker = "\n\n[… 본문 일부 생략 …]\n\n";
  const available = limit - marker.length * 2;
  if (available < 30) return text.slice(0, limit);

  const headLength = Math.floor(available * 0.5);
  const middleLength = Math.floor(available * 0.2);
  const tailLength = available - headLength - middleLength;
  const middleStart = Math.floor((text.length - middleLength) / 2);
  return [
    text.slice(0, headLength),
    marker,
    text.slice(middleStart, middleStart + middleLength),
    marker,
    text.slice(text.length - tailLength),
  ].join("");
}
