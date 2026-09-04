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
 * Repair the most common way an LLM breaks JSON: LaTeX inside a string value
 * (e.g. "\frac", "\right", "\pi", "\mathbb") where the backslash is not a valid
 * JSON escape. Walk the text tracking string state and double any lone
 * backslash that begins a LaTeX command, while leaving genuine escapes
 * (\", \\, \/, \uXXXX, and control \n/\t/\r) intact.
 *
 * The hard case is \n/\t/\r/\f/\b: these are valid JSON control escapes AND the
 * start of common LaTeX commands (\nabla, \times, \right, \frac, \beta). We
 * disambiguate by lookahead — if the next character is a lowercase latin
 * letter, it is a LaTeX command word (\right, \nabla) and the backslash is
 * escaped; otherwise (\n\n, \n#, \n다음, end of value) it is a real control
 * escape and kept. Raw control chars inside strings are also escaped.
 */
export function repairLlmJson(s: string): string {
  const isLowerLatin = (ch: string) => ch >= "a" && ch <= "z";
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    if (c === '"') { out += c; inStr = false; continue; }
    if (c === "\\") {
      const n1 = s[i + 1];
      const n2 = s[i + 2] ?? "";
      if (n1 === '"' || n1 === "\\" || n1 === "/") {
        out += c + n1; i++; // unambiguous escape
      } else if (n1 === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        out += s.slice(i, i + 6); i += 5; // \uXXXX
      } else if ((n1 === "n" || n1 === "t" || n1 === "r" || n1 === "f" || n1 === "b") && !isLowerLatin(n2)) {
        out += c + n1; i++; // genuine control escape, not a LaTeX word
      } else {
        out += "\\\\"; // LaTeX command / spacing (\frac, \pi, \,) → escape it
      }
    } else if (c === "\n") { out += "\\n"; }
    else if (c === "\r") { out += "\\r"; }
    else if (c === "\t") { out += "\\t"; }
    else { out += c; }
  }
  return out;
}

/** Return the first balanced {…} or […] block, or null if there is none. */
function extractBalancedJson(cleaned: string): string | null {
  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  const candidates = [objStart, arrStart].filter((i) => i !== -1);
  if (candidates.length === 0) return null;
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
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse JSON from an LLM response that may be wrapped in prose or code fences.
 * Tries, in order: the cleaned text as-is, a backslash/control-char repair of
 * it, then the first balanced {...}/[...] block (raw, then repaired) — so a
 * stray LaTeX backslash in a string value no longer fails the whole parse.
 */
export function parseLlmJson<T = unknown>(raw: string): T {
  const cleaned = stripJsonFences(raw);
  const block = extractBalancedJson(cleaned);
  const attempts = [cleaned, repairLlmJson(cleaned)];
  if (block !== null) attempts.push(block, repairLlmJson(block));
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No JSON found in LLM response");
}

/**
 * Repair a display-math block the model opened with `$$` but closed with a lone
 * `$` (before a blank line or end of input), e.g. `$$u_m := \frac{T_m}{2m+1}$`.
 * The lone `$` is doubled so it becomes a proper `$$…$$` block. Without this the
 * unclosed `$$` pairs with the *next* `$$` far below and swallows the paragraphs
 * and headings in between into one broken "equation".
 */
export function repairMathDelimiters(md: string): string {
  return md.replace(/(\$\$(?:(?!\$\$|\n\n)[\s\S])*?)\$(?!\$)(?=[^$\n]*(?:\n\n|$))/g, "$1$$$$");
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
