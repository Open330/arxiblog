# Codex functional-quality 결과

- 빌드 출력 경로 탈출과 외부 디렉터리 삭제/배포 위험을 차단했다.
- 설정을 권한 0600 임시 파일에서 원자적으로 교체하고 레거시 기본값을 보완했다.
- staging 빌드 교체로 실패 시 last-known-good 정적 사이트를 보존한다.
- HTTP JSON/길이/메서드 경계, 챗 in-flight quota, 정적 symlink/MIME/캐시 헤더를 보강했다.
- arXiv ID 검증, fetch timeout, PDF 50MiB 스트리밍 상한, 추출 텍스트 상한을 추가했다.
- 글/주석 저장을 트랜잭션화하고 slug 충돌 데이터 손상을 차단했다.
- 기능·보안 회귀 테스트를 추가했다.
