import type { LLMClient } from "../llm-client";
import type { Store, Post } from "../store";

const MAX_CONTEXT_CHARS = 14_000;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Answer a reader's question grounded in the post, its annotations, and the
 * source paper's abstract/body. Used by the in-page chat sidebar.
 */
export async function answerQuestion(
  llm: LLMClient,
  store: Store,
  post: Post,
  question: string,
  history: ChatTurn[]
): Promise<string> {
  const paper = store.getPaperByArxivId(post.arxiv_id || "");
  const annotations = store.getAnnotations(post.id);

  const glossary = annotations.map((a) => `- ${a.term}: ${a.explanation}`).join("\n");
  const paperContext = paper
    ? `제목: ${paper.title}\n초록: ${paper.abstract}\n\n[본문 발췌]\n${(paper.raw_text || "").slice(0, MAX_CONTEXT_CHARS)}`
    : "(원문 정보 없음)";

  const system = `당신은 arXiv 논문을 일반 독자에게 친절하게 설명해 주는 조수입니다.
독자가 블로그 글을 읽다가 던지는 질문에, 아래에 주어진 [블로그 글], [용어집], [원문 논문] 내용을 근거로 답합니다.

규칙:
- 비전공자 눈높이로, 쉽고 명료한 한국어로 답합니다.
- 짧고 핵심적으로 (보통 2~5문장). 필요하면 비유를 듭니다.
- 주어진 자료에서 답을 찾을 수 없으면 모른다고 솔직히 말하고, 추측은 추측이라고 밝힙니다.
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

  return (await llm.chatComplete(system, user, 1024)).trim();
}
