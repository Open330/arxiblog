<div align="center">

# 📄 → 📝 arxiblog

**어려운 arXiv 논문을, 읽고 싶은 블로그 글로.**

arXiv 논문 하나를 넣으면 — LLM이 학계 사람이 아니어도 술술 읽히는 "논문 읽기 블로그" 글로 바꿔줍니다.
전문용어엔 자동 주석, 흐름엔 **mermaid 도식**, 읽다 막히면 옆의 **AI 챗**. 웹 관리 페이지에서 논문 추가·설정까지.

`Bun` · `TypeScript` · `MIT` · [라이브 데모](https://arxiblog.jiun.dev)

</div>

---

## 미리보기

<div align="center">

|  홈  |  논문 읽기 블로그  |
|:----:|:------------------:|
| <img src="https://raw.githubusercontent.com/Open330/arxiblog/master/assets/screenshots/home.png" width="420"> | <img src="https://raw.githubusercontent.com/Open330/arxiblog/master/assets/screenshots/post.png" width="420"> |

</div>

<table>
<tr>
<td width="33%"><b>용어 주석</b><br>밑줄 위에 마우스 → 팝오버 + 글 하단 용어집<br><img src="https://raw.githubusercontent.com/Open330/arxiblog/master/assets/screenshots/annotation.png"></td>
<td width="33%"><b>mermaid 도식</b><br>구조·흐름을 다이어그램으로 자동 시각화<br><img src="https://raw.githubusercontent.com/Open330/arxiblog/master/assets/screenshots/diagram.png"></td>
<td width="33%"><b>AI 챗</b><br>논문·글 맥락 기반 Q&A (드래그-질문·추천 질문)<br><img src="https://raw.githubusercontent.com/Open330/arxiblog/master/assets/screenshots/chat.png"></td>
</tr>
</table>

> 위 스크린샷은 [arxiblog.jiun.dev](https://arxiblog.jiun.dev)에 실제로 추가된 논문들 (Attention Is All You Need, ViT, BERT, GAN 등)에서 캡처했습니다.

---

## 무엇을 하나요

`arxiblog add 1706.03762` 한 줄이면:

1. 📥 **arXiv에서 논문을 가져오고** (메타데이터 + PDF 본문 추출)
2. ✍️ **사람이 쓴 듯한 블로그 글로 재구성합니다** — 배경 → 풀려는 문제 → 핵심 아이디어 → 방법 → 결과 → 의의/한계 흐름의 "논문 읽기" 형식 (목록 나열이 아닌 흐르는 문단)
3. 📖 **전문용어에 자동 주석** — 밑줄 친 단어에 마우스를 올리면 설명 팝오버, 글 맨 아래엔 **용어집**
4. 📊 **mermaid 도식** — 구조·파이프라인·흐름을 다이어그램으로 자동 시각화
5. 💬 **토글형 AI 챗** — 그 논문·글의 맥락을 아는 AI에게 모르는 걸 바로 질문
6. 🌐 **정적 사이트로 빌드 & 배포** (GitHub Pages / Vercel) — 다크/라이트 테마, 모던 디자인

웹 브라우저에서도 **관리 페이지**로 논문 추가·설정·글 삭제를 할 수 있습니다 (`/admin`).
[themoonlight.io](https://www.themoonlight.io)의 논문 리뷰처럼, 한 편의 글로 논문을 따라 읽게 해주는 것을 목표로 합니다.

## 빠른 시작

```bash
# 0) Bun 필요 (https://bun.sh)
mkdir my-blog && cd my-blog

# 1) CLI 설치 후 프로젝트 생성 (LLM 프로바이더/키 입력)
bun add --global @open330/arxiblog
arxiblog init

# 2) 논문 추가 — ID, abs URL, pdf URL 모두 OK
arxiblog add 1706.03762
arxiblog add https://arxiv.org/abs/2106.09685
arxiblog add arXiv:2010.11929v1

# 3) 로컬에서 보기 (AI 챗 + 관리 페이지 포함)
arxiblog serve            # → http://localhost:8000
# 콘솔에 /admin#token=... 관리 페이지 주소가 출력됩니다

# (선택) 같은 네트워크의 다른 기기에서도 열기
arxiblog serve --host 0.0.0.0 -p 8088   # → http://<이-기기-IP>:8088
```

## 명령어

| 명령 | 설명 |
|------|------|
| `arxiblog init [name]` | 새 블로그 프로젝트 생성 (LLM 설정) |
| `arxiblog add <id\|url>` | arXiv 논문을 블로그 글로 변환 |
| `arxiblog build` | 정적 사이트 빌드 |
| `arxiblog serve [-p 8000] [--host 0.0.0.0]` | 로컬 서버 (AI 챗 + `/admin` 관리 페이지) |
| `arxiblog list` | 작성된 글 목록 |
| `arxiblog remove <slug>` | 글 삭제 |
| `arxiblog status` | 프로젝트 상태 · 토큰 사용량 |
| `arxiblog deploy [-t gh-pages\|vercel]` | 사이트 배포 |

## 웹 관리 페이지 (`/admin`)

`arxiblog serve` 실행 시 콘솔에 `http://localhost:8000/admin#token=…` 주소가 출력됩니다. fragment의 토큰은 프록시로 전송되지 않고 브라우저 세션에만 보관됩니다. 이 페이지에서:

- 📥 **논문 추가** — arXiv ID/URL 입력 → 페르소나·난이도 골라 바로 글 생성
- ⚙️ **설정** — LLM 프로바이더·모델·API Key, 기본 페르소나·난이도 변경
- 📝 **글 목록 / 삭제**

상태를 바꾸는 API(`/api/add`, `/api/settings`, `/api/delete`)는 **토큰 인증**이 필요합니다. `--host 0.0.0.0`으로 LAN에 열어도 토큰 없이는 추가·설정을 못 합니다(읽기·블로그는 공개). 토큰은 서버를 켤 때마다 새로 발급됩니다.

### `add` 옵션

```bash
arxiblog add 2305.12345 --level intermediate   # 난이도: beginner(기본) | intermediate
arxiblog add 2305.12345 --persona engineer      # 글쓰기 톤 선택
arxiblog add 2305.12345 --no-build              # 변환만 하고 빌드는 건너뛰기
```

## 글쓰기 페르소나

`personas/*.json`에 정의된 톤 중에서 고릅니다. `arxiblog.toml`의 `active_persona`로 기본값을 바꿀 수 있습니다.

| 페르소나 | 누구를 위한 글인가 |
|----------|--------------------|
| `friendly` (기본) | 비전공자·학생·개발자 — 비유 많은 쉬운 해설 |
| `engineer` | 실무 개발자 — "그래서 어떻게 써먹나" 중심 |
| `storyteller` | 과학 교양 독자 — 이야기처럼 읽히는 내러티브 |

직접 JSON 파일을 추가해 나만의 페르소나를 만들 수도 있습니다.

## AI 챗은 어떻게 동작하나요

각 글 우측 하단의 **💬 물어보기** 버튼을 누르면 사이드 패널이 열립니다.
질문을 보내면 `/api/chat` 엔드포인트가 **그 글 + 용어집 + 원문 논문 본문**을 컨텍스트로 LLM에 질의해 답합니다.

- 챗은 `arxiblog serve` (로컬 서버) 모드에서 동작합니다.
- GitHub Pages 같은 정적 호스팅에 배포하면 글·주석·용어집은 그대로 보이고, 챗 버튼은 "serve 모드에서 동작" 안내를 표시합니다.

## macOS에서 상시 운영

공개 터널이나 리버스 프록시의 원본 서버로 운영할 때는 터미널의 백그라운드 작업 대신 LaunchAgent를 사용하면 로그인 후 자동 시작되고 비정상 종료 시 재시작됩니다. 먼저 사이트를 빌드한 다음 설치하세요.

```bash
# 이 저장소에서 실행
cd /path/to/blog-project
/path/to/arxiblog/scripts/macos-launch-agent.sh install \
  --project "$PWD" --source /path/to/arxiblog \
  --label com.example.arxiblog --host 127.0.0.1 --port 8088

# 상태와 최소 헬스 응답 확인
/path/to/arxiblog/scripts/macos-launch-agent.sh status \
  --project "$PWD" --label com.example.arxiblog --port 8088
```

서비스는 재시작 중 불완전한 결과물을 게시하지 않도록 `--no-build`로 실행됩니다. 콘텐츠 변경 후에는 `arxiblog build`를 성공시킨 뒤 `restart` 하세요. 프로젝트 설정과 `~/Library/Logs/arxiblog/<label>/`의 서버 로그는 권한 `0600`으로 보호하며, API 키를 plist나 프로세스 인자에 복사하지 않습니다. LaunchAgent에서 발급된 최신 관리자 URL은 비공개 `server.log`의 마지막 시작 메시지에서 확인합니다. 프록시의 upstream은 `http://127.0.0.1:8088`, 헬스체크는 `GET /healthz`로 설정할 수 있습니다.

## 아키텍처

```
arXiv ID / URL
    ↓
[ Ingest ]   ── export.arxiv.org API (메타, 429 백오프) + arxiv.org PDF (격리 worker, 제한 시간)
    ↓
[ Transform ]── LLM: "논문 읽기 블로그" 글 + [[용어]] 주석 + mermaid 도식 (구조화 JSON)
    ↓
[ Store ]    ── SQLite (papers / posts / annotations / usage_logs)
    ↓
[ Build ]    ── 정적 HTML (마크다운 + KaTeX + mermaid + 주석 팝오버 + 용어집 + 챗)
    ↓
[ Serve ]    ── 정적 파일 + /api/chat + /admin (토큰 인증 관리 API)
    ↓
[ Deploy ]   ── GitHub Pages / Vercel
```

```
project/
├── arxiblog.toml      # 프로젝트 + LLM 설정
├── arxiblog.db        # SQLite
└── _site/             # 빌드 결과
    ├── index.html     # 랜딩 + 글 목록 (홈)
    ├── p/<slug>.html  # 각 글
    ├── posts.json
    └── static/        # style.css, app.js

src/
├── index.ts                 # CLI (commander)
├── config.ts / store.ts / llm-client.ts / utils.ts
├── ingest/arxiv.ts          # arXiv 메타 + PDF 추출 (SSRF 가드, 429 백오프)
├── pipeline/add.ts          # ingest→transform→store (CLI·웹 공용)
├── pipeline/transform.ts    # 논문 → 블로그 글 변환 (말투·도식 프롬프트)
├── pipeline/chat.ts         # 논문 맥락 기반 Q&A
├── build/renderer.ts        # 마크다운 → HTML (주석·수식·mermaid)
├── build/templates.ts       # 글/홈/관리 HTML 템플릿
├── build/static/            # style.css, app.js (테마·진행률·TOC·챗·주석)
├── server.ts                # serve + /api/chat + /admin + 관리 API
└── deploy.ts
```

## 지원 LLM 프로바이더

| 프로바이더 | 추천 모델 | 비고 |
|-----------|----------|------|
| **Google Gemini** | `gemini-3.1-flash-lite` (빠름·저렴) / `gemini-2.5-flash` (품질) | [무료 API key](https://aistudio.google.com/) |
| Anthropic | `claude-sonnet-4-6` | API key 필요 |
| OpenAI | `gpt-5.4-nano` | API key 필요 |
| Azure OpenAI | (배포 이름) | Azure 구독 필요 |

품질(주석·도식 풍부함)은 더 큰 모델일수록 좋습니다 — flash-lite는 빠르고 저렴한 대신 주석 수가 적을 수 있습니다. 본문은 토큰 절약을 위해 약 48,000자까지만 사용합니다.

## 면책

생성된 글은 LLM이 논문을 재구성한 것으로, 부정확하거나 누락된 내용이 있을 수 있습니다.
각 글은 원문 arXiv 링크를 함께 표시하며, **정확한 내용은 반드시 원문을 확인하세요.**

## 라이선스

MIT — `open330`. kiwimu(`@open330/kiwimu`)의 설계를 참고했습니다.
