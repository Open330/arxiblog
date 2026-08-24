import type { LLMClient } from "../llm-client";
import type { Store, Post } from "../store";
import { representativeText } from "../utils";
import { latinTerms, retrieve, snippet } from "./retrieval";

const MAX_CONTEXT_CHARS = 14_000;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A paper passage the answer was grounded in, surfaced to the reader. */
export interface ChatSource {
  text: string;
  section?: string;
}

export interface ChatAnswer {
  answer: string;
  /** Retrieved source passages (empty when grounding fell back to a plain slice). */
  sources: ChatSource[];
}

/** Map a reader's intent to the paper section most likely to answer it. */
const SECTION_INTENTS: Array<{ keywords: RegExp; pattern: RegExp }> = [
  { keywords: /한계|단점|문제점|약점|리스크|한계점|limitation|weakness|drawback/i, pattern: /limitation|discussion|conclusion/i },
  { keywords: /실험|결과|성능|정확도|벤치마크|수치|개선|비교|평가|score|result|accuracy|performance|experiment|benchmark|evaluation/i, pattern: /experiment|result|evaluation/i },
  { keywords: /방법|어떻게|모델|구조|알고리즘|아키텍처|작동|동작|원리|수식|method|approach|architecture|algorithm|how\b/i, pattern: /method|approach|model|architecture/i },
  { keywords: /왜|동기|목적|배경|의의|기여|contribution|motivation|why|background|problem/i, pattern: /introduction|background|motivation/i },
];

function inferSectionBoost(question: string): { pattern: RegExp; factor: number } | undefined {
  for (const intent of SECTION_INTENTS) {
    if (intent.keywords.test(question)) return { pattern: intent.pattern, factor: 1.6 };
  }
  return undefined;
}


/**
 * Answer a reader's question grounded in the post, its annotations, and — most
 * importantly — the passages of the source paper most relevant to the question.
 * Returns the answer plus the source passages so the UI can show "원문 근거".
 */
export async function answerQuestion(
  llm: LLMClient,
  store: Store,
  post: Post,
  question: string,
  history: ChatTurn[]
): Promise<ChatAnswer> {
  const paper = store.getPaperByArxivId(post.arxiv_id || "");
  const annotations = store.getAnnotations(post.id);
  const rawText = paper?.raw_text || "";

  // Retrieve against the question plus the reader's recent questions, so a
  // follow-up like "그 부분 더 자세히" still resolves to the right section.
  const retrievalQuery = [
    question,
    ...history.filter((t) => t.role === "user").slice(-2).map((t) => t.content),
  ].join(" ");
  // Bridge the Korean question to the English paper with the post's own
  // vocabulary, and nudge toward the section the reader is asking about.
  const expandTerms = latinTerms([post.title, annotations.map((a) => a.term).join(" "), post.content || ""]);
  const passages = rawText
    ? retrieve(rawText, retrievalQuery, {
        k: 8,
        budgetChars: MAX_CONTEXT_CHARS,
        expandTerms,
        boostSection: inferSectionBoost(question),
      })
    : [];

  let bodyContext: string;
  const sources: ChatSource[] = [];
  if (passages.length > 0) {
    bodyContext = passages
      .map((p, i) => `[근거 ${i + 1}${p.section ? " · " + p.section : ""}]\n${p.text}`)
      .join("\n\n");
    for (const p of passages.slice(0, 3)) sources.push({ text: snippet(p.text, 260), section: p.section });
  } else {
    // No scorable overlap (e.g. a purely conceptual Korean question): fall back
    // to the old representative slice so we are never worse than before.
    bodyContext = representativeText(rawText, MAX_CONTEXT_CHARS);
  }

  const glossary = annotations.map((a) => `- ${a.term}: ${a.explanation}`).join("\n");
  const paperContext = paper
    ? `제목: ${paper.title}\n초록: ${paper.abstract}\n\n[원문 발췌 — 질문과 가장 관련된 부분]\n${bodyContext || "(본문 없음)"}`
    : "(원문 정보 없음)";

  const system = `당신은 arXiv 논문을 일반 독자에게 친절하게 설명해 주는 조수입니다.
독자가 블로그 글을 읽다가 던지는 질문에, 아래에 주어진 [블로그 글], [용어집], [원문 논문] 내용을 근거로 답합니다.

규칙:
- 비전공자 눈높이로, 쉽고 명료한 한국어로 답합니다.
- 짧고 핵심적으로 (보통 2~5문장). 필요하면 비유를 듭니다.
- [원문 발췌]에 번호가 붙은 [근거 N]이 있으면 그 내용을 우선 근거로 삼고, 원문에서 확인된 사실과 일반적 배경 설명을 구분해 말합니다.
- 주어진 자료에서 답을 찾을 수 없으면 모른다고 솔직히 말하고, 추측은 추측이라고 밝힙니다. 원문에 없는 수치나 결과를 지어내지 않습니다.
- 마크다운 장식은 최소화하고, 대화하듯 답합니다.`;

  const historyText = history
    .slice(-6)
    .map((t) => `${t.role === "user" ? "독자" : "조수"}: ${t.content}`)
    .join("\n");

  const user = `[블로그 글: ${post.title}]
${post.tldr ? "TL;DR: " + post.tldr + "\n" : ""}${(post.content || "").slice(0, 8000)}

[용어집]
${glossary || "(없음)"}

[원문 논문]
${paperContext}

${historyText ? "[이전 대화]\n" + historyText + "\n" : ""}[독자의 질문]
${question}`;

  const answer = (await llm.chatComplete(system, user, 1024)).trim();
  return { answer, sources };
}
