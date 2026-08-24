import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultConfig, saveConfig } from "../../src/config";
import { buildSite } from "../../src/build/renderer";
import { Store } from "../../src/store";

const root = mkdtempSync(join(tmpdir(), "arxiblog-r01-smoke-"));
const config = defaultConfig("읽기 좋은 AI 논문 노트");
config.project.tagline = "어려운 논문을, 읽고 싶은 글로.";
config.project.url = "http://127.0.0.1:4188";
saveConfig(root, config);

const store = new Store(join(root, "arxiblog.db"));
const seed = (id: string, slug: string, title: string, category: string, level: string) => {
  const paper = store.upsertPaper({
    arxiv_id: id,
    title: `${title}: 원문 논문 제목이 아주 길어져도 레이아웃이 안전한지 확인합니다`,
    authors: "Ada Lovelace, Alan Turing",
    abstract: "테스트 초록",
    categories: category,
    published: "2026-07-01",
    abs_url: `https://arxiv.org/abs/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
    raw_text: "테스트 본문",
  });
  const post = store.upsertPost({
    paper_id: paper.id,
    slug,
    title,
    subtitle: "전문용어와 복잡한 수식을 직관적인 흐름으로 따라가 보는 긴 부제목입니다.",
    tldr: "입력의 중요한 부분에 선택적으로 집중해 긴 문맥을 더 효율적으로 이해하는 방법입니다.",
    takeaways: ["핵심 아이디어를 직관적으로 이해합니다.", "실제 적용의 장점과 한계를 함께 봅니다."],
    level,
    reading_minutes: 12,
    persona: "friendly",
    contributions: ["순차 처리 없이 문맥 관계를 계산합니다."],
    strengths: ["병렬화하기 쉽고 장거리 관계를 포착합니다."],
    limitations: ["긴 입력에서는 계산량이 빠르게 늘어납니다."],
    prerequisites: ["벡터와 확률 분포의 기초"],
    who_should_read: "생성형 AI의 작동 원리를 큰 그림부터 이해하고 싶은 독자",
    suggested_questions: ["왜 어텐션이 필요한가요?", "실무에서는 어떤 한계가 있나요?"],
    content: `## 문제는 무엇이었을까

기존 방식은 긴 문장을 순서대로 읽어야 했습니다. [[어텐션]]은 관련 있는 단어를 바로 연결합니다.

> 핵심은 모든 정보를 똑같이 보지 않고 중요한 관계에 더 큰 가중치를 주는 것입니다.

## 핵심 아이디어

수식으로는 $Attention(Q,K,V)=softmax(QK^T/\\sqrt{d})V$처럼 표현합니다.

| 방식 | 장점 | 주의점 |
| --- | --- | --- |
| 순환 모델 | 순서 표현 | 병렬화 어려움 |
| 어텐션 | 관계 포착 | 긴 입력 비용 |

\`\`\`mermaid
flowchart LR
  A[입력] --> B[어텐션]
  B --> C[문맥 표현]
\`\`\`

### 실제로 어떻게 쓸까

\`\`\`ts
const result = attention(query, key, value);
\`\`\`

## 결과와 한계

빠른 학습이 가능하지만 입력 길이가 늘수록 메모리 비용을 함께 고려해야 합니다.`,
  });
  store.replaceAnnotations(post.id, [
    { term: "어텐션", kind: "concept", explanation: "입력에서 서로 관련 있는 부분에 가중치를 주는 계산 방식" },
  ]);
};

seed("1706.03762", "어텐션을-직관적으로-이해하기", "어텐션 하나로 충분하다는 말의 진짜 의미", "cs.AI, cs.LG", "beginner");
seed("2010.11929", "이미지를-조각으로-읽는-방법", "이미지를 단어처럼 읽으면 무엇이 달라질까", "cs.CV, cs.AI", "intermediate");

await buildSite(store, config, root);
store.close();
console.log(root);
