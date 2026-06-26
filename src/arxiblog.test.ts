import { test, expect, describe } from "bun:test";
import { parseArxivId } from "./ingest/arxiv";
import { parseLlmJson, slugify, estimateReadingMinutes, stripJsonFences } from "./utils";
import { renderPostBody, generateToc, injectHeadingIds } from "./build/renderer";
import type { Annotation } from "./store";

const ann = (term: string, explanation: string, kind = "jargon"): Annotation =>
  ({ id: 0, post_id: 0, term, kind, explanation } as Annotation);

describe("parseArxivId", () => {
  test("plain id, with version, abs/pdf URLs, prefix, old-style", () => {
    expect(parseArxivId("2605.31264")).toBe("2605.31264");
    expect(parseArxivId("2106.09685v2")).toBe("2106.09685v2");
    expect(parseArxivId("https://arxiv.org/abs/1706.03762")).toBe("1706.03762");
    expect(parseArxivId("https://arxiv.org/pdf/2010.11929")).toBe("2010.11929");
    expect(parseArxivId("arXiv:1810.04805")).toBe("1810.04805");
    expect(parseArxivId("math.GT/0309136")).toBe("math.GT/0309136");
  });
});

describe("parseLlmJson", () => {
  test("plain JSON", () => {
    expect(parseLlmJson<{ a: number }>('{"a":1}').a).toBe(1);
  });
  test("fenced JSON", () => {
    expect(parseLlmJson<{ a: number }>('```json\n{"a":2}\n```').a).toBe(2);
  });
  test("trailing prose with brace-y emoji does not fool the scanner", () => {
    const r = parseLlmJson<{ a: number; note: string }>('```json\n{"a":3,"note":"end :}"}\n```\n도움이 됐길 :}');
    expect(r.a).toBe(3);
  });
  test("braces inside string values are balanced correctly", () => {
    expect(parseLlmJson<{ s: string }>('prefix {"s":"a{b}c"} suffix').s).toBe("a{b}c");
  });
  test("stripJsonFences removes md fences", () => {
    expect(stripJsonFences("```json\n{}\n```")).toBe("{}");
  });
});

describe("slugify / reading time", () => {
  test("slugify keeps Korean, drops punctuation", () => {
    expect(slugify("Attention Is All You Need!")).toBe("attention-is-all-you-need");
    expect(slugify("어텐션 하나로 충분하다")).toBe("어텐션-하나로-충분하다");
  });
  test("reading time does not double-count Korean", () => {
    const korean = "한국어 ".repeat(500); // 1500 hangul chars
    expect(estimateReadingMinutes(korean)).toBe(3); // ~1500/500
    expect(estimateReadingMinutes("")).toBe(1); // floor at 1
  });
});

describe("renderPostBody", () => {
  test("math with < > is escaped (KaTeX-safe), currency preserved", async () => {
    const h = await renderPostBody("인라인 $f(x)<g(x)$ 그리고 가격 $5, $10.", []);
    expect(h).toContain("$f(x)&lt;g(x)$");
    expect(h).toContain("$5, $10");
  });
  test("annotation fuzzy match + plain fallback for unmatched", async () => {
    const h = await renderPostBody("핵심은 [[어텐션 메커니즘]]과 [[모르는용어]] 입니다.", [
      ann("어텐션", "집중 가중치 기법"),
    ]);
    expect(h).toContain("annot-pop"); // matched via substring fallback
    expect(h).not.toContain("annot-missing"); // unmatched renders as plain text
    expect(h).toContain("모르는용어");
  });
  test("annotation explanation is HTML-escaped (no XSS via popover)", async () => {
    const h = await renderPostBody("위험 [[term]] 끝.", [ann("term", '</span><img src=x onerror=alert(1)>')]);
    expect(h).not.toContain("<img src=x onerror");
    expect(h).toContain("&lt;img");
  });
  test("mermaid fence becomes <pre class=mermaid> with escaped arrows", async () => {
    const h = await renderPostBody("```mermaid\nflowchart TD\n  A --> B\n```", []);
    expect(h).toContain('<pre class="mermaid">');
    expect(h).toContain("--&gt;");
  });
});

describe("toc + heading ids", () => {
  test("generateToc dedupes ids; injectHeadingIds assigns them positionally", async () => {
    const md = "## 들어가며\n\n본문\n\n## 결과\n\n## 결과\n\n중복";
    const toc = generateToc(md);
    expect(toc.map((t) => t.id)).toEqual(["들어가며", "결과", "결과-1"]);
    const html = injectHeadingIds(await renderPostBody(md, []), toc);
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["들어가며", "결과", "결과-1"]);
  });
});
