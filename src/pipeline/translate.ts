import type { LLMClient } from "../llm-client";
import { parseLlmJson } from "../utils";

/**
 * English rendering of the human-readable subset of a BlogResult.
 * The structured-review arrays, annotations map, and lookup keys are NOT
 * translated here — only the reader-facing prose fields are.
 */
export interface TranslatedPost {
  title: string;
  subtitle: string;
  tldr: string;
  takeaways: string[];
  content: string; // markdown; [[term]] markers, mermaid fences, $math$ preserved verbatim
  who_should_read: string;
}

/** The Korean source subset we translate. Mirrors TranslatedPost. */
export interface KoreanPostInput {
  title: string;
  subtitle: string;
  tldr: string;
  takeaways: string[];
  content: string;
  who_should_read: string;
}

// A [[term]] marker: double brackets, no nested ] or newline. The Korean text
// inside is a lookup key into the annotations map and must survive verbatim.
const MARKER_RE = /\[\[[^\]\n]+\]\]/g;
// A fenced mermaid block. Node labels are baked into the rendered diagram, so
// the whole block must survive verbatim.
const MERMAID_RE = /```mermaid[\s\S]*?```/g;

function uniqueMatches(text: string, re: RegExp): string[] {
  return [...new Set(text.match(re) ?? [])];
}

function buildSystemPrompt(): string {
  return `You are a faithful, expert technical translator. You turn a Korean blog post into natural, fluent English. The post explains an arXiv research paper to a general, non-expert audience, so your English must read like a native writer wrote it for that audience — clear, warm, and readable, never stiff or word-for-word.

Translate the MEANING, not the words. Reorder and rephrase so each sentence sounds natural in English. But you MUST preserve the following EXACTLY:

1. MARKDOWN STRUCTURE — Keep the same heading levels and order (every \`##\` stays \`##\`, every \`###\` stays \`###\`), the same lists, blockquotes, bold/italic, and paragraph breaks. Do not add, drop, merge, or reorder sections.

2. [[term]] ANNOTATION MARKERS — The text inside double brackets is a lookup key and MUST stay in the ORIGINAL KOREAN, byte-for-byte, brackets included. Translate ONLY the surrounding prose. Never translate, transliterate, pluralize, or alter what is inside [[ ]]. Example: "[[셀프 어텐션]]은 핵심입니다" → "[[셀프 어텐션]] is the core idea". The marker "[[셀프 어텐션]]" appears unchanged in your output.

3. \`\`\`mermaid FENCED BLOCKS — Copy every mermaid code block through COMPLETELY UNCHANGED, including the Korean node and edge labels. The labels must match the already-rendered diagram, so do not translate or touch anything between the mermaid fences.

4. MATH — Keep all LaTeX math unchanged: inline \`$...$\` and block \`$$...$$\` are copied verbatim.

Output ONLY a single JSON object, no code fence, with exactly these keys:
{
  "title": "natural English title",
  "subtitle": "one-sentence English subtitle",
  "tldr": "2-3 sentence English summary",
  "takeaways": ["english takeaway 1", "english takeaway 2", "..."],
  "content": "## English Heading\\n\\n...full translated markdown body with every [[한국어 용어]] marker and every mermaid block preserved verbatim...",
  "who_should_read": "english recommendation sentence"
}
Escape newlines inside JSON string values as \\n. Return the same number of takeaways as the source. Do not wrap the JSON in \`\`\`.`;
}

function buildUserPrompt(ko: KoreanPostInput): string {
  // Present the source as a JSON object so the field-to-field mapping is 1:1
  // and the model returns matching keys.
  const source = JSON.stringify(
    {
      title: ko.title,
      subtitle: ko.subtitle,
      tldr: ko.tldr,
      takeaways: ko.takeaways,
      content: ko.content,
      who_should_read: ko.who_should_read,
    },
    null,
    2
  );
  return `Translate this Korean blog post into English following every rule above. Return ONLY the JSON object.

SOURCE (Korean):
${source}`;
}

/**
 * Translate the reader-facing fields of a post from Korean to English in a
 * single LLM call. Preserves markdown structure, [[term]] lookup keys, mermaid
 * blocks, and math.
 *
 * Throws a clear Error when the model returns unusable output (empty content,
 * or a body that dropped [[term]] markers / mermaid blocks) so the caller can
 * skip the English variant for that post rather than publish a broken one.
 */
export async function translatePostToEnglish(
  llm: LLMClient,
  ko: KoreanPostInput
): Promise<TranslatedPost> {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(ko);
  const raw = await llm.chatComplete(system, user, 16_384);

  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (e) {
    throw new Error(
      `번역 응답을 JSON으로 파싱하지 못했습니다. 영어 변환을 건너뜁니다.\n${(e as Error).message}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("번역 응답 형식이 객체가 아닙니다. 영어 변환을 건너뜁니다.");
  }
  const value = parsed as Record<string, unknown>;

  const stringField = (name: string): string => {
    const field = value[name];
    if (field === undefined || field === null) return "";
    if (typeof field !== "string") {
      throw new Error(`번역 응답의 ${name} 필드가 문자열이 아닙니다. 영어 변환을 건너뜁니다.`);
    }
    return field.trim();
  };
  const stringArray = (name: string): string[] => {
    const field = value[name];
    if (field === undefined || field === null) return [];
    if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
      throw new Error(`번역 응답의 ${name} 필드가 문자열 배열이 아닙니다. 영어 변환을 건너뜁니다.`);
    }
    return field.map((item) => item.trim()).filter(Boolean);
  };

  const content = stringField("content");
  if (!content) {
    throw new Error("번역 결과 본문이 비어 있습니다. 영어 변환을 건너뜁니다.");
  }

  // Post-check: every [[term]] lookup key in the source must survive verbatim.
  // These are keys into the annotations map — a dropped/altered one silently
  // breaks the term-annotation feature, so we reject rather than publish it.
  const missingMarkers = uniqueMatches(ko.content, MARKER_RE).filter(
    (marker) => !content.includes(marker)
  );
  if (missingMarkers.length > 0) {
    throw new Error(
      `번역 본문에서 [[용어]] 주석 마커가 사라졌습니다 (${missingMarkers
        .slice(0, 5)
        .join(", ")}). 영어 변환을 건너뜁니다.`
    );
  }

  // Post-check: every mermaid block must survive verbatim so the diagram labels
  // still match what gets rendered.
  const missingMermaid = uniqueMatches(ko.content, MERMAID_RE).filter(
    (block) => !content.includes(block)
  );
  if (missingMermaid.length > 0) {
    throw new Error(
      `번역 본문에서 mermaid 다이어그램 블록이 변경/누락되었습니다. 영어 변환을 건너뜁니다.`
    );
  }

  return {
    title: stringField("title") || ko.title,
    subtitle: stringField("subtitle"),
    tldr: stringField("tldr"),
    takeaways: stringArray("takeaways"),
    content,
    who_should_read: stringField("who_should_read"),
  };
}
