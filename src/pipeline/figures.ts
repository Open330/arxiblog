/**
 * Figure explanation: given a paper's title and its figures' captions, ask the
 * LLM to write a short plain-Korean explanation of what each figure shows and
 * why it matters. The model never sees the images — only the captions — so it
 * is instructed to explain strictly from the caption text and not invent
 * specifics. Best-effort: any failure yields an empty list rather than throwing.
 */

import type { LLMClient } from "../llm-client";
import type { PaperFigure } from "../ingest/figures";
import { parseLlmJson } from "../utils";

export interface ExplainedFigure {
  imageUrl: string;
  caption: string;
  explanation: string;
}

const DEFAULT_MAX_FIGURES = 4;
const MAX_CAPTION_CHARS = 400;

const SYSTEM_PROMPT = [
  "당신은 arXiv 논문의 그림 캡션을 한국어로 풀어 설명하는 조수입니다.",
  "각 그림에 대해 캡션만 보고(이미지는 볼 수 없습니다) 그 그림이 무엇을 보여주며 왜 중요한지 1~2문장으로 설명하세요.",
  "규칙:",
  "- 반드시 주어진 캡션에 담긴 내용만 근거로 삼으세요. 캡션에 없는 수치·결과·세부사항을 지어내지 마세요.",
  "- 캡션이 모호하면 캡션이 말하는 범위 안에서만 일반적으로 설명하세요.",
  "- 쉬운 한국어 평문으로 쓰고, 전문 용어는 필요한 만큼만 사용하세요.",
  '- 출력은 오직 JSON 배열 하나입니다: 문자열의 배열이며, i번째 문자열이 i번째 그림의 설명입니다. 그림 개수와 배열 길이가 같아야 합니다.',
  "- JSON 외의 다른 텍스트나 코드펜스를 절대 포함하지 마세요.",
].join("\n");

function truncate(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n).trimEnd() + "…" : t;
}

/**
 * Produce a Korean explanation for each figure (up to `maxFigures`) in a single
 * LLM call. Figures the model did not explain are kept with an empty
 * explanation. Returns [] on total failure.
 */
export async function explainFigures(
  llm: LLMClient,
  meta: { title: string },
  figures: PaperFigure[],
  maxFigures = DEFAULT_MAX_FIGURES
): Promise<ExplainedFigure[]> {
  const limit = Math.max(1, Math.floor(maxFigures) || DEFAULT_MAX_FIGURES);
  const selected = (figures || []).filter((f) => f && f.imageUrl && f.caption).slice(0, limit);
  if (selected.length === 0) return [];

  const title = (meta?.title || "").trim() || "(제목 없음)";
  const captionsBlock = selected
    .map((f, i) => {
      const label = f.label ? `[${f.label}] ` : "";
      return `${i + 1}. ${label}${truncate(f.caption, MAX_CAPTION_CHARS)}`;
    })
    .join("\n");

  const userPrompt = [
    `논문 제목: ${title}`,
    "",
    `아래 ${selected.length}개 그림의 캡션입니다. 각 캡션에 대해 1~2문장 한국어 설명을 작성하세요.`,
    "",
    captionsBlock,
    "",
    `길이 ${selected.length}짜리 JSON 문자열 배열만 출력하세요.`,
  ].join("\n");

  try {
    const raw = await llm.chatComplete(SYSTEM_PROMPT, userPrompt, 1024);
    const parsed = parseLlmJson<unknown>(raw);
    const explanations = normalizeExplanations(parsed, selected.length);
    return selected.map((f, i) => ({
      imageUrl: f.imageUrl,
      caption: f.caption,
      explanation: explanations[i] || "",
    }));
  } catch {
    return [];
  }
}

/**
 * Coerce the LLM reply into an ordered array of explanation strings. Accepts a
 * plain string array, or an array of objects with an `explanation`/`설명` field
 * (optionally keyed by a 1-based `index`), so a slightly off-format reply still
 * maps back correctly.
 */
function normalizeExplanations(parsed: unknown, count: number): string[] {
  const out: string[] = new Array(count).fill("");
  if (!Array.isArray(parsed)) return out;

  parsed.forEach((item, i) => {
    if (typeof item === "string") {
      if (i < count) out[i] = item.trim();
      return;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const text = obj.explanation ?? obj["설명"] ?? obj.text;
      if (typeof text !== "string") return;
      const idxRaw = obj.index ?? obj.i ?? obj["번호"];
      const idx = typeof idxRaw === "number" && Number.isInteger(idxRaw) ? idxRaw - 1 : i;
      if (idx >= 0 && idx < count) out[idx] = text.trim();
    }
  });
  return out;
}
