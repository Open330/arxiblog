# R01 — 출시 준비 폴리싱 및 품질 개선

## 목표

arxiblog를 실제 출시 가능한 수준으로 다듬는다. 기존 기능과 사용자 변경을 보존하며, 전문적인 시각 완성도, 접근성·직관성, 기능 신뢰성, 엔지니어링 최적화를 개선한다.

## 공통 원칙

- 현재 브랜치에서 직접 작업하되 아래 파일 소유권을 엄격히 지킨다.
- 관련 구현을 먼저 읽고 실제 문제에 근거한 변경만 한다.
- 사용자 데이터/API key/토큰을 로그나 산출물에 노출하지 않는다.
- 의미 있는 동작 변경에는 테스트를 추가하거나 기존 테스트로 검증한다.
- 범위 밖 문제는 수정하지 말고 최종 메시지에 구체적으로 보고한다.
- 커밋하지 않는다.

## Agent A — visual-polish

소유 파일: `src/build/static/style.css`만 수정 가능.

- 홈·글·관리자·챗 UI를 하나의 전문적인 디자인 시스템처럼 폴리싱한다.
- 명확한 hover/focus-visible/disabled 상태, 터치 타깃, 대비, 반응형, 긴 콘텐츠 overflow, 모바일 safe area를 점검한다.
- `prefers-reduced-motion`, forced-colors/고대비 등 접근성을 고려한다.
- 기존 템플릿의 클래스와 기능을 깨뜨리지 않는다.
- 필요한 HTML/JS 변경은 직접 하지 말고 보고한다.

## Agent B — frontend-ux-a11y

소유 파일: `src/build/templates.ts`, `src/build/static/app.js`만 수정 가능.

- 랜드마크, 레이블, live region, dialog semantics, 키보드·포커스 관리 등 접근성을 개선한다.
- 테마 토글 상태, 검색 결과 상태, 챗 열기/닫기·로딩·오류·재시도 UX를 직관적으로 개선한다.
- 기본 SEO/메타데이터와 외부 링크 안전성, 정적 호스팅/서브패스 호환성에서 명백한 문제를 점검한다.
- XSS/HTML escaping 규칙을 보존한다.
- CSS 수정은 하지 말고 필요한 셀렉터/상태를 보고한다.

## Agent C — functional-quality

소유 파일: `src/server.ts`, `src/build/renderer.ts`, `src/config.ts`, `src/store.ts`, `src/utils.ts`, `src/pipeline/**`, `src/ingest/**`, `src/arxiblog.test.ts` 중 필요한 파일만 수정 가능. `templates.ts`, `app.js`, `style.css`는 수정 금지.

- 기존 테스트와 코드 경로를 실행·분석해 기능 오류, 보안/안정성, 성능 병목을 찾고 고친다.
- 입력 경계, HTTP 상태/헤더, 요청 크기, 오류 처리, 자원 정리, 반복 계산 등 출시 리스크를 우선한다.
- 회귀 테스트를 추가한다. 외부 네트워크/실제 LLM key가 필요한 테스트는 만들지 않는다.
- 공개 API/저장 데이터 호환성을 불필요하게 깨지 않는다.

## Root — 통합 및 최종 검증

- 모든 diff를 검토하고 충돌/회귀를 수정한다.
- 타입 검사, 전체 테스트, CLI/build/serve smoke test를 수행한다.
- 생성된 홈/글/관리자 화면을 데스크톱·모바일 브라우저에서 실제 조작하며 확인한다.
- 완료된 구현과 남은 출시 우려 사항을 심각도·근거와 함께 보고한다.
