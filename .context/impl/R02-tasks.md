# R02 — 남은 출시 우려 제거

## 공통 목표

R01의 출시 준비 변경을 보존하면서, 남은 LLM timeout/E2E, 재시작·다중 프로세스 quota, 외부 CDN 의존, PDF CPU 격리, 라이브 운영 가용성 문제를 실제 구현과 검증으로 줄인다.

## 공통 원칙

- 공유 작업 트리이므로 소유 파일을 엄격히 지킨다. 커밋하지 않는다.
- 기존 공개 설정과 데이터베이스는 호환되어야 한다.
- 외부 API key·실제 과금 없이 mock/fake server로 실패·timeout·성공 경로를 검증한다.
- 새 의존성은 크기·빌드 시간·배포 재현성 trade-off를 측정하고 최소화한다.
- 테스트는 기존 `src/arxiblog.test.ts`와 충돌하지 않도록 새 파일에 추가한다.

## Agent A — llm-timeout-e2e

소유 파일: `src/llm-client.ts`, 새 `src/llm-client.test.ts`만 수정 가능.

- Gemini raw fetch와 OpenAI/Anthropic/Azure SDK 호출에 명시적인 전체 요청 timeout/abort를 적용한다.
- timeout을 재시도 가능 오류로 분류하되 총 시간 상한이 무한히 늘어나지 않도록 deadline 기반으로 설계한다.
- 사용자에게 provider/timeout 맥락이 있는 안전한 오류를 제공하고 API key나 응답 전문은 노출하지 않는다.
- fake fetch/mock SDK 수준에서 성공, HTTP 오류, timeout, retry/deadline을 검증한다.
- 실제 provider E2E를 대체할 수 있는 결정적 smoke test를 만든다.

## Agent B — durable-chat-quota

소유 파일: `src/store.ts`, `src/server.ts`, 새 `src/server-quota.test.ts`만 수정 가능.

- 현재 메모리 기반 per-IP/hour 및 global/day quota가 프로세스 재시작·다중 인스턴스에서 우회되는 문제를 SQLite 기반 원자적 quota로 개선한다.
- in-flight 예약, 성공 정산, 실패 해제, 만료 정리를 트랜잭션으로 보장한다.
- 기존 DB migration과 기본 설정을 깨지 않으며 IP 원문은 가능하면 저장하지 않고 안정적인 해시를 사용한다.
- 동시성·재시작·일일/시간 경계·실패 해제 회귀 테스트를 추가한다.

## Agent C — local-static-assets

소유 파일: `package.json`, `bun.lock`, `src/build/templates.ts`, `src/build/renderer.ts`, `src/build/static/**` 중 필요한 파일, 새 `src/build/assets.test.ts`만 수정 가능.

- Pretendard·KaTeX·Mermaid의 런타임 외부 CDN 의존을 제거하거나 실질적으로 축소한다.
- npm에 정확히 고정된 자산을 빌드 결과로 복사/번들하고, 정적 페이지가 오프라인에서도 글·수식·도식을 렌더하도록 한다.
- 사이트·npm 패키지 크기와 빌드 시간 증가를 측정한다. 전체 Mermaid dist 복사보다 필요한 단일 번들을 선호한다.
- GitHub Pages 서브패스, local serve, CSP 친화성, 다크 테마를 유지한다.
- 네트워크 요청 없이 생성 HTML이 로컬 자산만 참조하는 테스트를 추가한다.

## Root — PDF/운영/통합

- PDF 파싱을 별도 worker/process에 격리하고 timeout·종료·오류 fallback을 검증한다.
- Cloudflare 502 원인을 읽기 전용으로 진단하고, repo 안에 재현 가능한 상시 프로세스/healthcheck 운영 구성을 추가한다.
- 현재 머신에서 안전하게 복구할 수 있으면 서비스와 터널을 검증한다. DNS/자격증명 변경은 기존 구성과 명확히 일치할 때만 수행한다.
- 전체 타입·테스트·audit·package·브라우저·라이브 URL을 재검증한다.
