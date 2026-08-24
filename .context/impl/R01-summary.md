# R01 통합 요약

## 완료

- 전문적인 홈/글/관리자/챗 시각 폴리싱과 다크·모바일·고대비·감소 모션 대응
- 키보드/스크린리더/포커스/IME/검색/오류 재시도 UX 개선
- 원자적·경로 제한 빌드/설정/배포, 요청·PDF 자원 상한, 저장 트랜잭션 개선
- CLI·웹 삭제 시 DB와 정적 사이트 일관성 보장
- TypeScript 고정, `check`/`prepublishOnly`, 공개 scoped package 설정
- Anthropic SDK 취약 버전 범위 제거, Mermaid CDN 정확 버전 고정

## 검증

- `bun run check`: TypeScript + 31 tests
- `bun audit --production`: 0 vulnerabilities
- Bun CLI bundle 및 npm package dry-run
- HTTP 200/400/401/404/405, 관리자 인증/설정, CLI 삭제 smoke
- Chromium desktop/mobile/dark: 홈·글·관리자·404 및 검색·테마·주석·챗 조작

## 출시 전 외부 조치

- `https://arxiblog.jiun.dev`는 2026-07-15 기준 Cloudflare 502이므로 상시 원본 서비스 복구가 필요하다.
- LLM/PDF CPU 작업 격리, 분산 quota 저장소, CDN self-host/SRI는 운영 규모에 맞춰 후속 결정한다.
