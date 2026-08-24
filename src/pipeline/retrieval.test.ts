import { describe, expect, test } from "bun:test";
import { chunkText, retrieve, snippet, tokenize } from "./retrieval";

const PAPER = `Abstract
We study fast optimization for deep networks.

1 Introduction
Deep learning has transformed computer vision over the last decade.
Most systems rely on stochastic gradient descent for training.

3 Method
We propose a novel Newton-style optimizer that approximates the Hessian.
The key idea is a low-rank update that avoids materializing the full matrix.
This makes second-order optimization tractable for large transformer models.

4 Experiments
On ImageNet our optimizer converges in half the epochs of Adam.
We report a final accuracy of 82.4 percent, a clear improvement.`;

describe("tokenize", () => {
  test("lowercases, drops 1-char tokens and stopwords, keeps latin + hangul", () => {
    const toks = tokenize("The Hessian 행렬은 무엇인가요?");
    expect(toks).toContain("hessian");
    expect(toks).toContain("행렬은");
    expect(toks).not.toContain("the"); // stopword
    expect(toks).not.toContain("무엇"); // korean stopword
  });

  test("empty / symbol-only input yields no tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("?! ... —")).toEqual([]);
  });
});

describe("chunkText", () => {
  test("splits into passages and carries the nearest section heading", () => {
    const passages = chunkText(PAPER);
    expect(passages.length).toBeGreaterThan(2);
    const sections = passages.map((p) => p.section);
    expect(sections.some((s) => /Method/.test(s || ""))).toBe(true);
    expect(sections.some((s) => /Experiments/.test(s || ""))).toBe(true);
    // reading order is preserved
    expect(passages.map((p) => p.index)).toEqual(passages.map((_, i) => i));
  });

  test("empty text yields no passages", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  \n ")).toEqual([]);
  });
});

describe("retrieve", () => {
  test("ranks the question-relevant section first", () => {
    const hits = retrieve(PAPER, "How does the Newton optimizer approximate the Hessian?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text.toLowerCase()).toContain("hessian");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  test("a question about results surfaces the experiments passage", () => {
    const hits = retrieve(PAPER, "what accuracy did they report on imagenet?");
    expect(hits[0].text.toLowerCase()).toMatch(/imagenet|accuracy|82\.4/);
  });

  test("returns nothing to ground on when the query shares no terms", () => {
    expect(retrieve(PAPER, "김치찌개 레시피 알려줘")).toEqual([]);
    expect(retrieve(PAPER, "")).toEqual([]);
    expect(retrieve("", "hessian")).toEqual([]);
  });

  test("expandTerms bridges a Korean-only question to an English paper", () => {
    // The raw Korean question shares no tokens with the English paper...
    expect(retrieve(PAPER, "핵심 방법이 뭐야?")).toEqual([]);
    // ...but the post's English vocabulary as expansion terms lands it on content.
    const hits = retrieve(PAPER, "핵심 방법이 뭐야?", {
      expandTerms: ["Newton", "optimizer", "Hessian", "transformer"],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text.toLowerCase()).toMatch(/newton|hessian|optimizer/);
  });

  test("boostSection steers toward the intended section", () => {
    // "optimizer" appears in both Method and Experiments, so the boost decides
    // which section wins the top slot.
    const q = "optimizer";
    const toMethod = retrieve(PAPER, q, { boostSection: { pattern: /method/i, factor: 3 } });
    const toExperiments = retrieve(PAPER, q, { boostSection: { pattern: /experiment|result/i, factor: 3 } });
    expect(toMethod[0].section).toMatch(/Method/);
    expect(toExperiments[0].section).toMatch(/Experiments/);
  });

  test("de-boosts boilerplate sections (references/acknowledgements)", () => {
    const paper = `1 Method
The proposed transformer optimizer uses a novel low-rank update.

References
[1] A transformer optimizer paper. In NeurIPS.
[2] Another transformer optimizer reference. In ICML.`;
    const hits = retrieve(paper, "transformer optimizer");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].section).toMatch(/Method/); // content ranks above References
  });

  test("respects the character budget", () => {
    const hits = retrieve(PAPER, "optimizer training gradient hessian imagenet accuracy", {
      budgetChars: 200,
      k: 8,
    });
    const total = hits.reduce((sum, p) => sum + p.text.length, 0);
    // At most one passage may cross the budget (the first is always admitted).
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(total - hits[hits.length - 1].text.length).toBeLessThanOrEqual(200);
  });
});

describe("snippet", () => {
  test("passes short text through unchanged", () => {
    expect(snippet("short text", 240)).toBe("short text");
  });

  test("trims long text at a word boundary with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const s = snippet(long, 40);
    expect(s.length).toBeLessThanOrEqual(41);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toContain("  ");
  });
});
