import { describe, expect, test } from "bun:test";
import type { LLMClient } from "../llm-client";
import type { ArxivMeta } from "../ingest/arxiv";
import { representativeText } from "../utils";
import { transformToBlog } from "./transform";

const meta: ArxivMeta = {
  arxivId: "2601.00001",
  title: "Fallback title",
  authors: ["Test Author"],
  abstract: "Abstract",
  categories: ["cs.SE"],
  published: "2026-01-01",
  absUrl: "https://arxiv.org/abs/2601.00001",
  pdfUrl: "https://arxiv.org/pdf/2601.00001",
};

const persona = {
  name: "test",
  description: "test",
  audience: "독자",
  style: "명료하게",
};

function llmResponse(value: unknown): LLMClient {
  return {
    chatComplete: async () => JSON.stringify(value),
  } as unknown as LLMClient;
}

describe("transform output validation", () => {
  test("accepts a valid minimal structured response", async () => {
    const result = await transformToBlog(
      llmResponse({
        title: "제목",
        content: "## 본문\n\n내용",
        annotations: [{ term: "용어", kind: "concept", explanation: "설명" }],
      }),
      meta,
      "paper",
      persona,
      "beginner"
    );
    expect(result.title).toBe("제목");
    expect(result.annotations).toEqual([{ term: "용어", kind: "concept", explanation: "설명" }]);
  });

  test("rejects type-wrong JSON with a retryable user-facing error", async () => {
    await expect(transformToBlog(
      llmResponse({ content: 42, annotations: {} }),
      meta,
      "paper",
      persona,
      "beginner"
    )).rejects.toThrow("content 필드가 문자열이 아닙니다");
  });
});

describe("representative long-paper context", () => {
  test("retains beginning, middle, and conclusion within the budget", () => {
    const text = `HEAD-${"a".repeat(470)}-MIDDLE-${"b".repeat(470)}-TAIL`;
    const excerpt = representativeText(text, 240);
    expect(excerpt.length).toBeLessThanOrEqual(240);
    expect(excerpt).toContain("HEAD");
    expect(excerpt).toContain("MIDDLE");
    expect(excerpt).toContain("TAIL");
    expect(excerpt).toContain("본문 일부 생략");
  });
});
