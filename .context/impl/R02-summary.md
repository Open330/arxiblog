# R02 통합 결과 — 남은 출시 우려 개선

## 완료한 개선

- LLM 호출에 25초 attempt timeout, 75초 전체 deadline, 제한된 retry/backoff와 안전한 오류 메시지를 적용했다. Gemini 유료 키는 명시적인 quota 소진 뒤에만 fallback한다.
- 종료된 `gemini-3.1-flash-lite-preview` 기본값을 안정 버전 `gemini-3.1-flash-lite`로 교체하고 기존 exact slug 설정을 런타임 마이그레이션한다.
- 관리자에서 provider 변경 시 기존 credential/endpoint/이전 model을 격리하고 새 provider 기본 모델·경고·확인 흐름을 제공한다.
- 기본 Gemini/OpenAI/Anthropic 모델의 비용 추정을 모델별로 보정하고 UI/CLI에 실제 청구액과 다를 수 있음을 명시했다.
- 공개 AI chat quota를 SQLite 원자적 예약/정산으로 옮겨 재시작·동시 프로세스에서도 per-IP/hour, global/day, max-in-flight 제한을 공유한다. 원문 IP는 저장하지 않는다.
- PDF 파싱을 Worker로 격리해 timeout 시 종료하고, PDF 크기 상한·versioned arXiv metadata/PDF URL 보존을 검증했다.
- Pretendard, KaTeX, Mermaid를 정확한 버전의 로컬 자산으로 전환했다. 필요한 글에만 rich renderer를 로드하고 라이선스를 함께 배포한다.
- Markdown code/annotation/math/Mermaid 경계를 보강해 XSS, placeholder collision, invalid paragraph nesting, tight-list 의미 회귀를 막았다.
- 외부 게시물 이미지를 제거해 추적 요청을 차단하고 외부 링크는 보존한다.
- 설정/SQLite/WAL/SHM을 `0600`으로 보호하고 일반 500 응답에서 내부 오류·비밀이 노출되지 않게 했다.
- `/healthz`, macOS LaunchAgent, Cloudflare tunnel 실행/healthcheck 스크립트를 추가했다.
- npm 패키지에서 테스트 소스를 제외하고 운영 스크립트 실행 권한을 유지했다.

## 검증 결과

- `bun run check`: 70 pass, 0 fail, 352 assertions
- `bun audit --production`: 취약점 0건
- `npm pack --dry-run`: 28 files, 76,350 B compressed / 247,867 B unpacked, 테스트 파일 0개
- Node 정적 JS 구문, 두 셸 스크립트 구문, `git diff --check` 통과
- 실제 Chromium desktop/mobile: 홈, 검색, 테마, 키보드 주석, chat panel, Mermaid SVG, KaTeX, 404, 가로 overflow 없음, console/page error 없음
- 실제 Gemini chat: HTTP 200, 10.745초, 145자 응답, usage log 1건 증가
- 데모: 5개 글, SQLite integrity `ok`, pending quota 0, local homepage/health HTTP 200, config 무인증 401, 잘못된 method 405
- 데모 설정/DB/WAL/SHM 권한 모두 `0600`; LaunchAgent `com.open330.arxiblog-demo`가 `127.0.0.1:8088`에서 실행 중

## 크기·성능 trade-off

- 기본 로컬 글꼴 포함 사이트 약 1.63 MB
- KaTeX 글이 있으면 약 2.19 MB, Mermaid 글이 있으면 약 5.19 MB, 둘 다 있으면 약 5.75 MB
- 대표 빌드 중앙값은 plain 11.8 ms, math 39.3 ms, Mermaid 14.2 ms, both 67.7 ms였다.
- Mermaid classic bundle이 가장 큰 증가분이지만 ESM은 200개가 넘는 chunk를 요구해 오프라인 단일 배포의 단순성과 교환했다.

## 외부 가용성 blocker

- 로컬 원본은 정상이나 `https://arxiblog.jiun.dev`는 2026-07-15 최종 확인에서도 HTTP 502다.
- 실행 중인 remote-managed Cloudflare tunnel의 기존 ingress가 `127.0.0.1:8080`을 가리키고, arxiblog 원본은 충돌을 피하기 위해 `127.0.0.1:8088`을 사용한다. 8080은 다른 사용자 서비스가 점유하므로 변경하지 않았다.
- tunnel connector token은 실행 전용이고 remote ingress 수정에는 Cloudflare Tunnel Write 권한의 관리 API token 또는 Dashboard 세션이 필요하다. 해당 자격증명은 현재 환경에서 찾지 못해 외부 설정을 임의 변경하지 않았다.
- 필요한 조치는 해당 tunnel의 `arxiblog.jiun.dev` service만 `http://127.0.0.1:8088`로 바꾸고 public health/homepage를 재확인하는 것이다.

## 남은 비차단 우려

- 서로 다른 DB를 쓰는 다중 호스트 배포에서는 SQLite quota가 공유되지 않으므로 Redis/Postgres 같은 중앙 저장소가 필요하다.
- Worker timeout은 PDF CPU hang을 격리하지만 프로세스 전체 OOM까지 막지는 못한다. 고위험 공개 ingest로 확장하면 subprocess/컨테이너 memory limit가 필요하다.
- `/api/add`는 긴 동기 요청이며 durable job/idempotency key가 없다. 현재 UI는 연결 종료 후 목록 확인을 안내하지만 대규모 운영에는 queue가 적합하다.
- provider timeout/실패도 실제로 과금될 수 있으나 응답 usage가 없으면 로컬에서 정확히 집계할 수 없다. provider dashboard가 청구 기준이다.
- 고정 SHA-256 IP digest는 DB가 유출되면 작은 IP 공간을 대입할 수 있다. 현재 DB 권한은 `0600`이지만 고위험 환경에는 별도 secret salt/HMAC가 더 낫다.
- Mermaid transitive license 목록은 실제 조직의 배포 정책에 맞춘 법무 검토가 필요하다.
- LaunchAgent는 현재 workspace checkout을 직접 실행한다. 재현 가능한 운영 릴리스에는 commit/tag 또는 immutable artifact 고정이 필요하다.
