# Codex frontend-ux-a11y 결과

- `src/build/templates.ts`, `src/build/static/app.js`에 skip link, landmark, label, live region, dialog semantics를 적용했다.
- 테마 상태, 검색 결과 안내, TOC 활성 상태, 주석 키보드 조작을 보강했다.
- 챗 focus trap/복귀, IME Enter 보호, busy/error/retry UX를 구현했다.
- 관리자 목록 DOM 생성을 안전한 API로 전환하고 폼 busy/error 상태를 개선했다.
- 상대 자산/글 링크, canonical/OG/noindex를 추가해 정적 서브패스 배포 호환성을 높였다.
- 브라우저에서 검색·테마·주석·챗·모바일 overflow를 직접 검증했다.
