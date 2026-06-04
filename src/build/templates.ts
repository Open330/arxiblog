import type { ArxiblogConfig } from "../config";
import type { Post, Annotation } from "../store";
import { escapeHtml } from "../utils";

const KIND_LABEL: Record<string, string> = {
  jargon: "전문용어",
  concept: "핵심 개념",
  context: "배경지식",
  math: "수식·기호",
};

function head(title: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="/static/style.css">
<script>(function(){var t=localStorage.getItem("arxiblog-theme");if(t)document.documentElement.dataset.theme=t;})();</script>
</head>`;
}

function siteHeader(): string {
  return `<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="/">arxi<span>blog</span></a>
    <button id="theme-toggle" class="theme-toggle" aria-label="테마 전환">◐</button>
  </div>
</header>`;
}

function clientScripts(annotJson: string): string {
  return `<script>window.__ARXIBLOG_ANNOTATIONS__ = ${annotJson};</script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false})"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "Pretendard, sans-serif" });
</script>
<script defer src="/static/app.js"></script>`;
}

// ── Post page ──

export function renderPostPage(opts: {
  config: ArxiblogConfig;
  post: Post;
  bodyHtml: string;
  toc: Array<{ level: number; text: string; id: string }>;
  annotations: Annotation[];
}): string {
  const { post, bodyHtml, toc, annotations } = opts;
  const takeaways = safeParseArray(post.takeaways);
  const cats = (post.categories || "").split(",").map((c) => c.trim()).filter(Boolean);
  const absUrl = `https://arxiv.org/abs/${post.arxiv_id}`;
  const pdfUrl = `https://arxiv.org/pdf/${(post.arxiv_id || "").replace(/v\d+$/, "")}`;

  const tocItems = toc
    .map((h) => `<li class="lvl${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
    .join("");
  const tocRail = toc.length
    ? `<aside class="toc-rail"><nav class="toc"><div class="toc-title">목차</div><ul>${tocItems}</ul></nav></aside>`
    : "";
  const tocMobile = toc.length
    ? `<details class="toc-mobile"><summary>목차</summary><ul>${tocItems}</ul></details>`
    : "";

  const tldrBox = post.tldr
    ? `<aside class="callout tldr"><div class="callout-label">TL;DR</div><p>${escapeHtml(post.tldr)}</p></aside>`
    : "";
  const takeawaysBox = takeaways.length
    ? `<aside class="callout takeaways"><div class="callout-label">한눈에 보기</div><ul>${takeaways
        .map((t) => `<li>${escapeHtml(t)}</li>`)
        .join("")}</ul></aside>`
    : "";

  const glossary = annotations.length
    ? `<section class="glossary"><h2>용어 노트</h2><dl>${annotations
        .map(
          (a) =>
            `<div class="gloss-item"><dt>${escapeHtml(a.term)}<span class="gloss-kind">${escapeHtml(
              KIND_LABEL[a.kind] || a.kind
            )}</span></dt><dd>${escapeHtml(a.explanation)}</dd></div>`
        )
        .join("")}</dl></section>`
    : "";

  const catHtml = cats.map((c) => `<span class="cat">${escapeHtml(c)}</span>`).join("");
  const annotJson = jsonForScript(
    annotations.map((a) => ({ term: a.term, kind: a.kind, explanation: a.explanation }))
  );

  return `${head(post.title, post.subtitle || post.tldr || post.title)}
<body data-slug="${escapeHtml(post.slug)}">
<div id="progress-bar" class="progress-bar"></div>
${siteHeader()}
<main class="post-shell">
  <article class="post">
    <div class="post-meta">
      ${catHtml ? `<span class="cats">${catHtml}</span>` : ""}
      <span>${post.reading_minutes}분 읽기</span>
      <span class="level level-${escapeHtml(post.level)}">${post.level === "intermediate" ? "중급" : "입문"}</span>
    </div>
    <h1 class="post-title">${escapeHtml(post.title)}</h1>
    ${post.subtitle ? `<p class="post-subtitle">${escapeHtml(post.subtitle)}</p>` : ""}

    <div class="paper-card">
      <span class="paper-card-tag">원문 논문</span>
      <span class="paper-card-title">${escapeHtml(post.paper_title || "")}</span>
      <span class="paper-card-links">
        <a href="${absUrl}" target="_blank" rel="noopener">arXiv:${escapeHtml(post.arxiv_id || "")}</a>
        <a href="${pdfUrl}" target="_blank" rel="noopener">PDF ↗</a>
      </span>
    </div>

    ${tldrBox}
    ${takeawaysBox}
    ${tocMobile}

    <div class="post-body">
      ${bodyHtml}
    </div>

    ${glossary}

    <footer class="post-footer">
      이 글은 <a href="${absUrl}" target="_blank" rel="noopener">arXiv:${escapeHtml(post.arxiv_id || "")}</a> 논문을
      <b>arxiblog</b>가 일반 독자용으로 다시 쓴 글입니다. 정확한 내용은 원문을 확인하세요.
    </footer>
  </article>
  ${tocRail}
</main>

<button id="chat-toggle" class="chat-toggle" aria-label="AI에게 물어보기"><span>💬</span> 물어보기</button>
<div id="chat-panel" class="chat-panel" hidden>
  <div class="chat-head">
    <span>이 논문, 뭐든 물어보세요</span>
    <button id="chat-close" class="chat-close" aria-label="닫기">✕</button>
  </div>
  <div id="chat-log" class="chat-log">
    <div class="chat-msg bot">읽다가 막히는 부분이 있으면 편하게 물어보세요. 이 논문과 글 내용을 바탕으로 답해 드릴게요.</div>
  </div>
  <form id="chat-form" class="chat-form">
    <textarea id="chat-input" rows="1" placeholder="예: 핵심 아이디어를 한 문장으로?" autocomplete="off"></textarea>
    <button type="submit" aria-label="보내기">↑</button>
  </form>
</div>

${clientScripts(annotJson)}
</body>
</html>`;
}

// ── Index page ──

export function renderIndexPage(opts: { config: ArxiblogConfig; posts: Post[] }): string {
  const { config, posts } = opts;
  const cards = posts
    .map((p) => {
      const cats = (p.categories || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 3);
      return `<a class="card" href="/p/${escapeHtml(p.slug)}.html">
        <div class="card-meta">
          ${cats.map((c) => `<span class="cat">${escapeHtml(c)}</span>`).join("")}
          <span class="card-time">${p.reading_minutes}분</span>
        </div>
        <h2 class="card-title">${escapeHtml(p.title)}</h2>
        ${p.subtitle ? `<p class="card-subtitle">${escapeHtml(p.subtitle)}</p>` : ""}
        ${p.tldr ? `<p class="card-tldr">${escapeHtml(p.tldr)}</p>` : ""}
        <div class="card-source">arXiv:${escapeHtml(p.arxiv_id || "")}</div>
      </a>`;
    })
    .join("\n");

  const empty = `<div class="empty">
    <p>아직 글이 없습니다.</p>
    <p class="empty-hint"><code>arxiblog add 2605.31264</code> 처럼 arXiv 논문을 추가해 보세요.</p>
  </div>`;

  return `${head(config.project.name, config.project.tagline || "arXiv 논문을 읽기 쉬운 블로그로")}
<body>
${siteHeader()}
<main class="home">
  <section class="home-hero">
    <span class="hero-badge">arXiv → 읽고 싶은 글</span>
    <h1>${escapeHtml(config.project.name)}</h1>
    <p class="hero-sub">${escapeHtml(config.project.tagline || "어려운 논문을, 읽고 싶은 글로.")}</p>
    <p class="hero-desc">학계 사람이 아니어도 술술 읽히도록 논문을 다시 씁니다. 전문용어엔 자동 주석을, 흐름엔 도식을 붙이고, 읽다 막히면 옆의 AI에게 바로 물어보세요.</p>
    <div class="hero-steps">
      <div class="step"><span class="step-n">1</span><b>논문 넣기</b><span>arXiv ID·URL 하나면 끝</span></div>
      <div class="step"><span class="step-n">2</span><b>블로그로 변환</b><span>주석·도식·요약 자동 생성</span></div>
      <div class="step"><span class="step-n">3</span><b>읽고 물어보기</b><span>맥락을 아는 AI 챗 내장</span></div>
    </div>
  </section>
  <section class="home-list">
    <h2 class="home-list-title">${posts.length ? `글 ${posts.length}편` : "글"}</h2>
    <div class="cards">
      ${posts.length ? cards : empty}
    </div>
  </section>
</main>
<footer class="site-footer">arxiblog · arXiv 논문을 사람의 언어로</footer>
<script defer src="/static/app.js"></script>
</body>
</html>`;
}

// ── Admin page (served live in `serve` mode) ──

export function renderAdminPage(config: ArxiblogConfig): string {
  const personas = config.personas || [];
  const personaOpts = personas
    .map(
      (p) =>
        `<option value="${escapeHtml(p.name)}"${p.name === config.active_persona ? " selected" : ""}>${escapeHtml(
          p.name
        )} — ${escapeHtml(p.description)}</option>`
    )
    .join("");
  const provOpts = ["gemini", "anthropic", "openai", "azure-openai"]
    .map((p) => `<option value="${p}"${p === config.llm.provider ? " selected" : ""}>${p}</option>`)
    .join("");
  const levelOpts = [
    ["beginner", "입문"],
    ["intermediate", "중급"],
  ]
    .map(([v, l]) => `<option value="${v}"${v === config.default_level ? " selected" : ""}>${l}</option>`)
    .join("");

  return `${head("관리 · " + config.project.name, "arxiblog 관리 페이지")}
<body class="admin-body">
${siteHeader()}
<main class="admin">
  <h1>관리</h1>
  <p id="auth-note" class="admin-note"></p>

  <section class="admin-card">
    <h2>📥 논문 추가</h2>
    <form id="add-form">
      <label>arXiv ID 또는 URL
        <input id="add-source" placeholder="2605.31264 또는 https://arxiv.org/abs/..." required>
      </label>
      <div class="row">
        <label>페르소나<select id="add-persona">${personaOpts}</select></label>
        <label>난이도<select id="add-level">${levelOpts}</select></label>
      </div>
      <button type="submit">글 생성</button>
    </form>
    <div id="add-status" class="status"></div>
  </section>

  <section class="admin-card">
    <h2>⚙️ 설정</h2>
    <form id="settings-form">
      <div class="row">
        <label>프로바이더<select id="set-provider">${provOpts}</select></label>
        <label>모델<input id="set-model" value="${escapeHtml(config.llm.model)}"></label>
      </div>
      <label>API Key <input id="set-key" type="password" placeholder="${config.llm.api_key ? "설정됨 — 변경할 때만 입력" : "미설정"}"></label>
      <label>Azure Endpoint <span class="hint">(azure-openai만)</span><input id="set-endpoint" value="${escapeHtml(config.llm.endpoint || "")}"></label>
      <div class="row">
        <label>기본 페르소나<select id="set-persona">${personaOpts}</select></label>
        <label>기본 난이도<select id="set-level">${levelOpts}</select></label>
      </div>
      <button type="submit">설정 저장</button>
    </form>
    <div id="settings-status" class="status"></div>
  </section>

  <section class="admin-card">
    <h2>📝 글 목록</h2>
    <div id="post-list" class="post-list">불러오는 중…</div>
  </section>
</main>
<script>${adminScript()}</script>
</body>
</html>`;
}

function adminScript(): string {
  return [
    "(function(){",
    "var u=new URL(location.href);var tok=u.searchParams.get('token');",
    "if(tok){sessionStorage.setItem('arxiblog-admin-token',tok);history.replaceState({},'',location.pathname);}",
    "var token=sessionStorage.getItem('arxiblog-admin-token')||'';",
    "var note=document.getElementById('auth-note');",
    "if(!token){note.textContent='\\u26a0 토큰이 없습니다. 콘솔에 출력된 /admin?token=... 주소로 접속하세요.';note.classList.add('warn');}",
    "else{note.textContent='\\u2713 인증됨';note.classList.add('ok');}",
    "function api(path,method,body){return fetch(path,{method:method||'GET',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:body?JSON.stringify(body):undefined});}",
    "function esc(s){return (s||'').replace(/[&<>\"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
    "var addForm=document.getElementById('add-form');",
    "addForm.addEventListener('submit',async function(e){e.preventDefault();",
    " var src=document.getElementById('add-source').value.trim();if(!src)return;",
    " var st=document.getElementById('add-status');var btn=addForm.querySelector('button');",
    " btn.disabled=true;st.className='status busy';st.textContent='\\u23f3 논문을 가져와 글을 쓰는 중… (수십 초 걸릴 수 있어요)';",
    " try{var r=await api('/api/add','POST',{source:src,persona:document.getElementById('add-persona').value,level:document.getElementById('add-level').value});",
    "  var j=await r.json();",
    "  if(!r.ok||j.error){st.className='status err';st.textContent='오류: '+(j.error||r.status);}",
    "  else{st.className='status ok';st.innerHTML='\\u2705 <a href=\"/p/'+encodeURIComponent(j.slug)+'.html\">'+esc(j.title)+'</a> ('+j.annotations+'개 주석 · ~$'+(j.cost||0).toFixed(4)+')';document.getElementById('add-source').value='';loadPosts();}",
    " }catch(err){st.className='status err';st.textContent='요청 실패: '+err.message;}",
    " btn.disabled=false;",
    "});",
    "var setForm=document.getElementById('settings-form');",
    "setForm.addEventListener('submit',async function(e){e.preventDefault();",
    " var st=document.getElementById('settings-status');st.className='status busy';st.textContent='저장 중…';",
    " var body={provider:document.getElementById('set-provider').value,model:document.getElementById('set-model').value,endpoint:document.getElementById('set-endpoint').value,active_persona:document.getElementById('set-persona').value,default_level:document.getElementById('set-level').value};",
    " var k=document.getElementById('set-key').value;if(k)body.api_key=k;",
    " try{var r=await api('/api/settings','POST',body);var j=await r.json();var ok=r.ok&&!j.error;st.className=ok?'status ok':'status err';st.textContent=ok?'\\u2705 저장됨':'오류: '+(j.error||r.status);document.getElementById('set-key').value='';}catch(err){st.className='status err';st.textContent='요청 실패: '+err.message;}",
    "});",
    "async function loadPosts(){var el=document.getElementById('post-list');try{var r=await fetch('/api/posts');var j=await r.json();var ps=j.posts||[];if(!ps.length){el.innerHTML='<p class=\"muted\">아직 글이 없습니다.</p>';return;}el.innerHTML=ps.map(function(p){return '<div class=\"post-row\"><a href=\"/p/'+encodeURIComponent(p.slug)+'.html\">'+esc(p.title)+'</a><span class=\"muted\">arXiv:'+esc(p.arxiv_id)+' \\u00b7 '+p.reading_minutes+'분</span><button data-slug=\"'+esc(p.slug)+'\">삭제</button></div>';}).join('');Array.prototype.forEach.call(el.querySelectorAll('button[data-slug]'),function(b){b.addEventListener('click',async function(){if(!confirm('이 글을 삭제할까요?'))return;b.disabled=true;var r=await api('/api/delete','POST',{slug:b.getAttribute('data-slug')});if(r.ok){loadPosts();}else{var j=await r.json();alert('오류: '+(j.error||r.status));b.disabled=false;}});});}catch(err){el.textContent='목록을 불러오지 못했습니다.';}}",
    "loadPosts();",
    "})();",
  ].join("\n");
}

/** Serialize a value for safe embedding inside an inline <script> element. */
function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
