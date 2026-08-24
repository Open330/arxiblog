import type { LLMClient } from "../llm-client";
import type { Persona } from "../config";
import type { ArxivMeta } from "../ingest/arxiv";
import { parseLlmJson, estimateReadingMinutes, representativeText, slugify } from "../utils";

export interface BlogResult {
  title: string;
  subtitle: string;
  tldr: string;
  takeaways: string[];
  level: string;
  content: string; // markdown with [[term]] annotation markers
  annotations: Array<{ term: string; kind: string; explanation: string }>;
  // structured review
  contributions: string[];
  strengths: string[];
  limitations: string[];
  prerequisites: string[];
  who_should_read: string;
  suggested_questions: string[];
}

/** Cap raw paper text so we stay within a reasonable token budget. */
const MAX_BODY_CHARS = 48_000;

function buildSystemPrompt(persona: Persona, level: string): string {
  const levelGuide =
    level === "intermediate"
      ? "독자는 약간의 배경지식이 있다. 핵심 개념은 짚되 너무 기초적인 설명에 분량을 낭비하지 않는다."
      : "독자는 이 분야를 처음 접한다. 모든 전문용어를 풀어서 설명하고, 직관적인 비유를 적극 사용한다.";

  return `당신은 어려운 학술 논문을 직접 정독하고, 그걸 친구에게 들려주듯 풀어쓰는 인기 블로거입니다.
지금 쓰는 건 '요약문'이 아니라 사람이 쓴 한 편의 블로그 글입니다. 독자가 끝까지 읽고 "아, 이제 이해했다"고 느끼게 만드는 게 목표입니다.

[독자] ${persona.audience}
[톤·문체] ${persona.style}
[난이도] ${levelGuide}

[사람처럼 쓰기 — 가장 중요]
- 글에 '사람의 목소리'가 있어야 합니다. 논문을 처음 봤을 때의 반응, 의외였던 점, "이게 왜 어렵냐면…" 같은 자연스러운 도입을 넣으세요.
- **불릿/번호 목록을 남발하지 마세요.** 대부분의 내용은 흐르는 문단으로 풀어 씁니다. 목록은 진짜 나열(3~4개 항목)일 때만, 글 전체에서 2번 이내로만 씁니다.
- 문장 길이를 다양하게. 짧은 문장으로 리듬을 주고, 가끔 질문을 던지고, 비유로 그림을 그려 주세요.
- 번역투·AI 상투어를 피하세요: "본 논문은", "~를 제안한다", "결론적으로", "살펴보자", "~할 수 있다는 점에서 의의가 있다" 같은 딱딱한 표현 대신 사람이 말하듯 씁니다.
- 단락은 한 가지 생각을 담고, 다음 단락으로 자연스럽게 이어집니다. 소제목만 나열된 개요처럼 보이면 실패입니다.

[글의 흐름] 아래를 따르되 소제목은 내용에 맞게 매력적으로 직접 짓습니다. 각 섹션은 ## 헤딩으로 시작합니다.
1. 들어가며 — 독자가 공감할 질문/장면으로 연다. (절대 "이 글에서는 ~를 다룬다" 식으로 시작하지 말 것)
2. 풀려는 문제 — 기존 방식이 왜 답답했는지.
3. 핵심 아이디어 — 한 줄 핵심을 먼저 던지고, 직관부터.
4. 어떻게 동작하나 — 방법을 이야기하듯 단계적으로. 여기서 도식이 도움 되면 mermaid를 씁니다.
5. 결과 — 숫자보다 "그래서 뭐가 좋아졌나" 중심.
6. 그래서 뭐가 중요한가 / 한계 — 솔직하게.

[도식 — mermaid]
- 구조·파이프라인·흐름·관계를 글로만 설명하기 답답한 곳에 mermaid 다이어그램을 최소 1개 넣으세요 (보통 "어떻게 동작하나"에).
- 코드펜스 \`\`\`mermaid 로 감싸고, flowchart TD 또는 sequenceDiagram 등 단순한 문법을 씁니다.
- 노드 라벨은 짧은 한국어로. 라벨에 따옴표·괄호·특수문자는 넣지 말고 간결하게. 화살표 텍스트도 짧게.
- 예:
\`\`\`mermaid
flowchart TD
  A[흩어진 흔적] --> B[증류]
  B --> C[능력 규칙]
  B --> D[행동 규칙]
  C --> E[스킬 패키지]
  D --> E
\`\`\`

[용어 주석]
- 일반 독자가 모를 전문용어·개념·약어가 처음 나올 때 [[용어]]로 감쌉니다. 같은 용어는 한 번만.
- [[ ]]로 감싼 용어는 모두 annotations 배열에 1~2문장 해설을 넣습니다. 본문 흐름을 끊지 않도록 주석은 보충용으로.
- 핵심 용어 8~16개 목표. (mermaid 라벨 안에는 [[ ]]를 쓰지 마세요.)

[수식] 꼭 필요할 때만 LaTeX. 인라인 $...$, 블록 $$...$$. 쓰면 바로 말로도 풀어줍니다.

[구조화 리뷰 — 본문과 별개로 채웁니다] 독자가 본문을 읽기 전/후에 빠르게 판단할 수 있도록, 아래를 간결한 한국어로 채웁니다. 본문 내용과 일치해야 하며 지어내지 않습니다.
- contributions: 이 논문의 핵심 기여 2~4개 (각 한 줄).
- strengths: 인상적인 점·강점 2~3개 (각 한 줄).
- limitations: 솔직한 한계·주의점 2~3개 (각 한 줄). 논문이 안 밝혔으면 합리적으로 추론하되 단정하지 않습니다.
- prerequisites: 이 글을 더 잘 읽기 위해 알면 좋은 선행 개념 2~4개 (각 짧은 구).
- who_should_read: "이런 분께 추천" 한 문장.
- suggested_questions: 독자가 던질 법한 좋은 질문 3개 (각 한 줄, 챗에 바로 쓸 수 있게).

[출력 형식] 아래 JSON 객체 하나만. 코드펜스 없이 JSON만.
{
  "title": "사람이 쓴 듯한, 클릭하고 싶은 한국어 제목 (과장 금지)",
  "subtitle": "한 문장 부제",
  "tldr": "2~3문장 핵심 요약",
  "takeaways": ["핵심 한 줄 1", "핵심 한 줄 2", "핵심 한 줄 3"],
  "content": "## 들어가며\\n\\n...마크다운 본문 (흐르는 문단 중심, [[용어]] 주석과 필요시 mermaid 포함)...",
  "annotations": [
    { "term": "용어", "kind": "jargon", "explanation": "비전공자용 1~2문장 해설" }
  ],
  "contributions": ["기여 1", "기여 2"],
  "strengths": ["강점 1", "강점 2"],
  "limitations": ["한계 1", "한계 2"],
  "prerequisites": ["선행 개념 1", "선행 개념 2"],
  "who_should_read": "이런 분께 추천: ...",
  "suggested_questions": ["질문 1", "질문 2", "질문 3"]
}
content 안의 mermaid 코드펜스 줄바꿈은 \\n 으로 정확히 이스케이프하세요. kind 값: "jargon" | "concept" | "context" | "math".`;
}

function buildUserPrompt(meta: ArxivMeta, rawText: string): string {
  const body = representativeText(rawText, MAX_BODY_CHARS);
  const truncatedNote =
    rawText.length > MAX_BODY_CHARS
      ? "\n\n[본문이 길어 도입부·중간·결론을 나누어 발췌함 — 제공된 근거 밖의 내용은 단정하지 마세요]"
      : "";
  return `다음 arXiv 논문을 위 지침에 따라 "논문 읽기 블로그" 글로 옮겨주세요.

제목: ${meta.title}
저자: ${meta.authors.join(", ") || "(정보 없음)"}
분야: ${meta.categories.join(", ") || "(정보 없음)"}
arXiv: ${meta.arxivId}

[초록]
${meta.abstract}

[본문 (PDF 추출)]
${body || "(본문 추출 실패 — 초록을 중심으로 작성하세요)"}${truncatedNote}`;
}

export async function transformToBlog(
  llm: LLMClient,
  meta: ArxivMeta,
  rawText: string,
  persona: Persona,
  level: string
): Promise<BlogResult> {
  const system = buildSystemPrompt(persona, level);
  const user = buildUserPrompt(meta, rawText);
  const raw = await llm.chatComplete(system, user, 16_384);

  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (e) {
    throw new Error(
      `LLM 응답을 JSON으로 파싱하지 못했습니다. 모델을 더 큰 것으로 바꾸거나 다시 시도해 주세요.\n${(e as Error).message}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM 응답 형식이 객체가 아닙니다. 다시 시도해 주세요.");
  }
  const value = parsed as Record<string, unknown>;
  const stringField = (name: string, fallback = ""): string => {
    const field = value[name];
    if (field === undefined || field === null || field === "") return fallback;
    if (typeof field !== "string") {
      throw new Error(`LLM 응답의 ${name} 필드가 문자열이 아닙니다. 다시 시도해 주세요.`);
    }
    return field.trim();
  };
  const stringArray = (name: string): string[] => {
    const field = value[name];
    if (field === undefined || field === null) return [];
    if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
      throw new Error(`LLM 응답의 ${name} 필드가 문자열 배열이 아닙니다. 다시 시도해 주세요.`);
    }
    return field.map((item) => item.trim()).filter(Boolean);
  };

  const content = stringField("content");
  if (!content) throw new Error("LLM이 빈 본문을 반환했습니다. 다시 시도해 주세요.");

  const rawAnnotations = value.annotations ?? [];
  if (!Array.isArray(rawAnnotations)) {
    throw new Error("LLM 응답의 annotations 필드가 배열이 아닙니다. 다시 시도해 주세요.");
  }
  const annotationKinds = new Set(["jargon", "concept", "context", "math"]);
  const annotations = rawAnnotations.map((annotation, index) => {
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
      throw new Error(`LLM 응답의 annotations[${index}] 형식이 올바르지 않습니다. 다시 시도해 주세요.`);
    }
    const item = annotation as Record<string, unknown>;
    if (typeof item.term !== "string" || typeof item.explanation !== "string") {
      throw new Error(`LLM 응답의 annotations[${index}]에 term/explanation 문자열이 필요합니다.`);
    }
    const term = item.term.trim();
    const explanation = item.explanation.trim();
    if (!term || !explanation) {
      throw new Error(`LLM 응답의 annotations[${index}]가 비어 있습니다. 다시 시도해 주세요.`);
    }
    const kind = typeof item.kind === "string" && annotationKinds.has(item.kind) ? item.kind : "jargon";
    return { term, kind, explanation };
  });

  const title = stringField("title", meta.title);
  return {
    title,
    subtitle: stringField("subtitle"),
    tldr: stringField("tldr"),
    takeaways: stringArray("takeaways"),
    level,
    content,
    annotations,
    contributions: stringArray("contributions"),
    strengths: stringArray("strengths"),
    limitations: stringArray("limitations"),
    prerequisites: stringArray("prerequisites"),
    who_should_read: stringField("who_should_read"),
    suggested_questions: stringArray("suggested_questions").slice(0, 5),
  };
}

/** Build a unique-ish slug from the title, falling back to the arxiv id. */
export function postSlug(meta: ArxivMeta, title: string): string {
  const base = slugify(title);
  // prefix arxiv id (without dots) to keep slugs unique & stable
  const idPart = meta.arxivId.replace(/[^\w]/g, "");
  return `${idPart}-${base}`.slice(0, 90);
}

export { estimateReadingMinutes };
