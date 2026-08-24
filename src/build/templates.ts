import type { ArxiblogConfig } from "../config";
import type { Post, Annotation } from "../store";
import { escapeHtml, splitCategories } from "../utils";

const KIND_LABEL: Record<string, string> = {
  jargon: "전문용어",
  concept: "핵심 개념",
  context: "배경지식",
  math: "수식·기호",
};

interface HeadOptions {
  assetPrefix?: string;
  canonicalUrl?: string;
  mathContent?: boolean;
  noindex?: boolean;
  ogType?: "article" | "website";
  siteName?: string;
  /** Absolute URL of the post's Open Graph image; "" or absent omits og:image. */
  ogImage?: string;
  /** <html lang> and og:locale (default "ko"). */
  htmlLang?: string;
  /** hreflang alternate links (KO/EN + x-default). */
  alternates?: Array<{ hreflang: string; href: string }>;
}

export function safePublicUrl(base: string | undefined, relativePath = ""): string {
  if (!base) return "";
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return relativePath ? new URL(relativePath.replace(/^\/+/, ""), url).href : url.href;
  } catch {
    return "";
  }
}

function safeCanonicalUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return "";
  }
}

/** Absolute-on-origin prefix for assets that must work from an arbitrary 404 URL. */
function publicBasePath(base: string | undefined): string {
  if (!base) return "/";
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "/";
    return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  } catch {
    return "/";
  }
}

function head(title: string, description: string, opts: HeadOptions = {}): string {
  const assetPrefix = opts.assetPrefix ?? "";
  const canonicalUrl = safeCanonicalUrl(opts.canonicalUrl);
  const ogImage = opts.ogImage || "";
  const feedTitle = opts.siteName || "arxiblog";
  const htmlLang = opts.htmlLang || "ko";
  const alternates = (opts.alternates || [])
    .map((a) => `<link rel="alternate" hreflang="${escapeHtml(a.hreflang)}" href="${escapeHtml(a.href)}">`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="${escapeHtml(htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="${opts.ogType || "website"}">
<meta property="og:locale" content="${htmlLang === "en" ? "en_US" : "ko_KR"}">
${opts.siteName ? `<meta property="og:site_name" content="${escapeHtml(opts.siteName)}">` : ""}
${alternates}
${canonicalUrl ? `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">\n<link rel="canonical" href="${escapeHtml(canonicalUrl)}">` : ""}
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">\n<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`}
${opts.noindex ? `<meta name="robots" content="noindex,nofollow">` : ""}
<link rel="icon" href="${assetPrefix}favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(feedTitle)}" href="${assetPrefix}feed.xml">
<link rel="stylesheet" href="${assetPrefix}static/fonts.css">
${opts.mathContent ? `<link rel="stylesheet" href="${assetPrefix}static/vendor/katex/katex.min.css">` : ""}
<link rel="stylesheet" href="${assetPrefix}static/style.css">
<script>(function(){try{var t=localStorage.getItem("arxiblog-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>`;
}

function siteHeader(homeHref: string, siteName: string): string {
  return `<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="${homeHref}" aria-label="${escapeHtml(siteName)} 홈">arxi<span>blog</span></a>
    <button id="theme-toggle" class="theme-toggle" type="button" aria-label="테마 전환" aria-pressed="false"><span aria-hidden="true">◐</span></button>
  </div>
</header>`;
}

function clientScripts(annotJson: string, assetPrefix: string, hasMath: boolean, hasMermaid: boolean): string {
  const richScripts = [
    hasMath ? `<script defer src="${assetPrefix}static/vendor/katex/katex.min.js"></script>
<script defer src="${assetPrefix}static/vendor/katex/auto-render.min.js"></script>` : "",
    hasMermaid ? `<script defer src="${assetPrefix}static/vendor/mermaid/mermaid.min.js"></script>` : "",
    hasMath || hasMermaid ? `<script defer src="${assetPrefix}static/rich.js"></script>` : "",
  ].filter(Boolean).join("\n");
  return `<script>window.__ARXIBLOG_ANNOTATIONS__ = ${annotJson};</script>
<script defer src="${assetPrefix}static/app.js"></script>
${richScripts}`;
}

// ── Post page ──

export function renderPostPage(opts: {
  config: ArxiblogConfig;
  post: Post;
  bodyHtml: string;
  toc: Array<{ level: number; text: string; id: string }>;
  annotations: Annotation[];
  hasMath?: boolean;
  hasMermaid?: boolean;
  related?: Array<{ slug: string; title: string; arxiv_id?: string; reading_minutes?: number }>;
  /** Absolute URL of this post's Open Graph image; "" or absent omits og:image. */
  ogImage?: string;
  /** "en" renders the English variant (translated hero + body via `en`). */
  lang?: "ko" | "en";
  /** KO page: an English translation exists → show the language toggle. */
  hasTranslation?: boolean;
  /** EN page: the translated hero fields (body comes in via bodyHtml). */
  en?: { title: string; subtitle: string; tldr: string; takeaways: string[]; who_should_read: string };
}): string {
  const { post, bodyHtml, toc, annotations, related = [] } = opts;
  const isEn = opts.lang === "en";
  const en = opts.en;
  const takeaways = safeParseArray(post.takeaways);
  const contributions = safeParseArray(post.contributions);
  const strengths = safeParseArray(post.strengths);
  const limitations = safeParseArray(post.limitations);
  const prerequisites = safeParseArray(post.prerequisites);
  const suggestedQuestions = safeParseArray(post.suggested_questions);
  const keyRefs = safeParseObjectArray<{ title: string; why: string; arxiv_id?: string }>(
    (post as { key_references?: string }).key_references
  ).filter((r) => r && typeof r.title === "string" && r.title.trim());

  // Display fields swap to the English translation on the EN variant page.
  const displayTitle = isEn && en ? en.title : post.title;
  const displaySubtitle = isEn && en ? en.subtitle : post.subtitle;
  const displayTldr = isEn && en ? en.tldr : post.tldr;
  const displayTakeaways = isEn && en ? en.takeaways : takeaways;

  // Paper figures with plain-language explanations (KO page only for now).
  const figures = safeParseObjectArray<{ imageUrl: string; caption: string; explanation: string }>(
    (post as { figures?: string }).figures
  ).filter((f) => f && typeof f.imageUrl === "string" && /^https:\/\//.test(f.imageUrl));
  const figuresHtml =
    !isEn && figures.length
      ? `<section class="figures"><h2>📊 논문 속 그림</h2>${figures
          .map(
            (f) =>
              `<figure class="paper-fig"><img src="${escapeHtml(f.imageUrl)}" alt="${escapeHtml(
                f.caption.slice(0, 300)
              )}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${escapeHtml(
                f.explanation || f.caption
              )}</figcaption></figure>`
          )
          .join("")}</section>`
      : "";

  // Language toggle (KO ⇄ EN).
  const langSwitch =
    opts.hasTranslation || isEn
      ? `<div class="lang-switch">
          <a href="./${encodeURIComponent(post.slug)}.html"${!isEn ? ' class="active" aria-current="page"' : ""}>한국어</a>
          <a href="./${encodeURIComponent(post.slug)}.en.html"${isEn ? ' class="active" aria-current="page"' : ""}>English</a>
        </div>`
      : "";

  const cats = splitCategories(post.categories);
  const arxivId = (post.arxiv_id || "").trim();
  const arxivPath = arxivId.split("/").map(encodeURIComponent).join("/");
  const absUrl = `https://arxiv.org/abs/${arxivPath}`;
  const pdfUrl = `https://arxiv.org/pdf/${arxivPath}`;
  const description = displaySubtitle || displayTldr || displayTitle;
  const canonicalUrl = safePublicUrl(
    opts.config.project.url,
    `p/${encodeURIComponent(post.slug)}${isEn ? ".en" : ""}.html`
  );

  const tocItems = toc
    .map((h) => `<li class="lvl${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
    .join("");
  const tocRail = toc.length
    ? `<aside class="toc-rail" aria-label="문서 목차"><nav class="toc" aria-label="이 글의 목차"><div class="toc-title" aria-hidden="true">목차</div><ul>${tocItems}</ul></nav></aside>`
    : "";
  const tocMobile = toc.length
    ? `<details class="toc-mobile"><summary>목차</summary><ul>${tocItems}</ul></details>`
    : "";

  const tldrBox = displayTldr
    ? `<aside class="callout tldr" aria-labelledby="tldr-title"><h2 id="tldr-title" class="callout-label">TL;DR</h2><p>${escapeHtml(displayTldr)}</p></aside>`
    : "";
  const takeawaysBox = displayTakeaways.length
    ? `<aside class="callout takeaways" aria-labelledby="takeaways-title"><h2 id="takeaways-title" class="callout-label">${isEn ? "At a glance" : "한눈에 보기"}</h2><ul>${displayTakeaways
        .map((t) => `<li>${escapeHtml(t)}</li>`)
        .join("")}</ul></aside>`
    : "";

  const reviewCol = (label: string, items: string[], cls: string) =>
    items.length
      ? `<div class="review-col ${cls}"><h3>${label}</h3><ul>${items
          .map((t) => `<li>${escapeHtml(t)}</li>`)
          .join("")}</ul></div>`
      : "";
  const reviewInner = [
    reviewCol("핵심 기여", contributions, "rc-contrib"),
    reviewCol("강점", strengths, "rc-strength"),
    reviewCol("한계", limitations, "rc-limit"),
    reviewCol("미리 알면 좋은 것", prerequisites, "rc-prereq"),
  ].join("");
  const reviewCard =
    reviewInner || post.who_should_read
      ? `<section class="review-card" aria-labelledby="review-title">
          <h2 id="review-title" class="review-head">📋 한눈에 리뷰</h2>
          <div class="review-grid">${reviewInner}</div>
          ${post.who_should_read ? `<div class="review-who">👤 ${escapeHtml(post.who_should_read)}</div>` : ""}
        </section>`
      : "";

  const chips = suggestedQuestions.length
    ? `<section class="ask-chips" aria-labelledby="ask-chips-title">
        <h2 id="ask-chips-title" class="ask-chips-label">💬 이런 게 궁금하다면 — 눌러서 AI에게 물어보세요</h2>
        <div class="ask-chips-row">${suggestedQuestions
          .map((q) => `<button class="ask-chip" type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
          .join("")}</div>
      </section>`
    : "";

  const citationsHtml = keyRefs.length
    ? `<section class="references"><h2>핵심 참고문헌</h2><ul class="ref-list">${keyRefs
        .map((r) => {
          const id = (r.arxiv_id || "").trim();
          const link = id
            ? `<a class="ref-link" href="https://arxiv.org/abs/${escapeHtml(id)}" target="_blank" rel="noopener">arXiv:${escapeHtml(id)} ↗</a>`
            : "";
          const why = (r.why || "").trim() ? `<span class="ref-why">${escapeHtml(r.why.trim())}</span>` : "";
          return `<li><span class="ref-title">${escapeHtml(r.title.trim())}</span>${why}${link}</li>`;
        })
        .join("")}</ul></section>`
    : "";

  const relatedHtml = related.length
    ? `<section class="related"><h2>관련 글</h2><div class="related-list">${related
        .map(
          (r) =>
            `<a class="related-item" href="./${encodeURIComponent(r.slug)}.html"><span class="related-title">${escapeHtml(
              r.title
            )}</span><span class="related-meta">arXiv:${escapeHtml(r.arxiv_id || "")}${
              r.reading_minutes ? " · " + r.reading_minutes + "분" : ""
            }</span></a>`
        )
        .join("")}</div></section>`
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

  // hreflang alternates when a KO/EN pair exists.
  const koHref = safePublicUrl(opts.config.project.url, `p/${encodeURIComponent(post.slug)}.html`);
  const enHref = safePublicUrl(opts.config.project.url, `p/${encodeURIComponent(post.slug)}.en.html`);
  const alternates =
    (opts.hasTranslation || isEn) && koHref && enHref
      ? [
          { hreflang: "ko", href: koHref },
          { hreflang: "en", href: enHref },
          { hreflang: "x-default", href: koHref },
        ]
      : [];

  return `${head(`${displayTitle} · ${opts.config.project.name}`, description, {
    assetPrefix: "../",
    canonicalUrl,
    mathContent: opts.hasMath,
    ogType: "article",
    siteName: opts.config.project.name,
    ogImage: opts.ogImage,
    htmlLang: isEn ? "en" : "ko",
    alternates,
  })}
<body data-slug="${escapeHtml(post.slug)}">
<a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
<div id="progress-bar" class="progress-bar" aria-hidden="true"></div>
${siteHeader("../", opts.config.project.name)}
<main id="main-content" class="post-shell">
  <article class="post" aria-labelledby="post-title">
    <div class="post-meta">
      ${catHtml ? `<span class="cats">${catHtml}</span>` : ""}
      <span>${post.reading_minutes}분 읽기</span>
      <span class="level level-${escapeHtml(post.level)}">${post.level === "intermediate" ? "중급" : "입문"}</span>
    </div>
    <h1 id="post-title" class="post-title">${escapeHtml(displayTitle)}</h1>
    ${displaySubtitle ? `<p class="post-subtitle">${escapeHtml(displaySubtitle)}</p>` : ""}
    ${langSwitch}

    <aside class="paper-card" aria-label="원문 논문 정보">
      <span class="paper-card-tag">원문 논문</span>
      <span class="paper-card-title">${escapeHtml(post.paper_title || "")}</span>
      <span class="paper-card-links">
        <a href="${escapeHtml(absUrl)}" target="_blank" rel="noopener noreferrer" aria-label="arXiv 원문 보기(새 탭)">arXiv:${escapeHtml(arxivId)}</a>
        <a href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener noreferrer" aria-label="논문 PDF 보기(새 탭)">PDF ↗</a>
      </span>
    </aside>

    ${tldrBox}
    ${takeawaysBox}
    ${isEn ? "" : reviewCard}
    ${isEn ? "" : chips}
    ${tocMobile}

    <div class="post-body">
      ${bodyHtml}
    </div>

    ${figuresHtml}
    ${glossary}
    ${isEn ? "" : citationsHtml}
    ${isEn ? "" : relatedHtml}

    <footer class="post-footer">
      이 글은 <a href="${escapeHtml(absUrl)}" target="_blank" rel="noopener noreferrer" aria-label="arXiv 원문 보기(새 탭)">arXiv:${escapeHtml(arxivId)}</a> 논문을
      <b>arxiblog</b>가 일반 독자용으로 다시 쓴 글입니다. 정확한 내용은 원문을 확인하세요.
    </footer>
  </article>
  ${tocRail}
</main>

<button id="chat-toggle" class="chat-toggle" type="button" aria-label="AI 질문 창 열기" aria-controls="chat-panel" aria-expanded="false" aria-haspopup="dialog"><span aria-hidden="true">💬</span> 물어보기</button>
<section id="chat-panel" class="chat-panel" role="dialog" aria-modal="true" aria-labelledby="chat-title" aria-describedby="chat-privacy" hidden>
  <div class="chat-head">
    <h2 id="chat-title">이 논문, 뭐든 물어보세요</h2>
    <button id="chat-close" class="chat-close" type="button" aria-label="AI 질문 창 닫기">✕</button>
  </div>
  <p id="chat-privacy" class="chat-privacy">질문·최근 대화·현재 글 맥락이 설정된 외부 AI 제공자에게 전송됩니다. 개인정보나 민감정보는 입력하지 마세요.</p>
  <div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-relevant="additions text" aria-label="AI 대화 내용">
    <div class="chat-msg bot">읽다가 막히는 부분이 있으면 편하게 물어보세요. 이 논문과 글 내용을 바탕으로 답해 드릴게요.</div>
  </div>
  <form id="chat-form" class="chat-form">
    <textarea id="chat-input" rows="1" placeholder="예: 핵심 아이디어를 한 문장으로?" aria-label="AI에게 할 질문" autocomplete="off" required></textarea>
    <button type="submit" aria-label="질문 보내기">↑</button>
  </form>
</section>

${clientScripts(annotJson, "../", !!opts.hasMath, !!opts.hasMermaid)}
</body>
</html>`;
}

// ── Index page ──

export function renderIndexPage(opts: { config: ArxiblogConfig; posts: Post[] }): string {
  const { config, posts } = opts;
  const canonicalUrl = safePublicUrl(config.project.url);
  const cards = posts
    .map((p) => {
      const cats = splitCategories(p.categories).slice(0, 3);
      const haystack = `${p.title} ${p.subtitle} ${p.tldr} ${p.categories || ""} ${p.arxiv_id || ""}`
        .toLowerCase();
      const cardCats = splitCategories(p.categories).map((c) => c.toLowerCase()).join(" ");
      return `<a class="card" href="p/${encodeURIComponent(p.slug)}.html" data-search="${escapeHtml(haystack)}" data-cats="${escapeHtml(cardCats)}">
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

  // Category filter chips (top categories by frequency).
  const catCounts = new Map<string, number>();
  for (const p of posts) for (const c of splitCategories(p.categories)) catCounts.set(c, (catCounts.get(c) || 0) + 1);
  const topCats = [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
  const catFilter =
    topCats.length > 1
      ? `<div class="cat-filter" id="cat-filter" role="group" aria-label="분야 필터">
          <button class="cat-chip active" type="button" data-cat="" aria-pressed="true">전체</button>${topCats
            .map((c) => `<button class="cat-chip" type="button" data-cat="${escapeHtml(c.toLowerCase())}" aria-pressed="false">${escapeHtml(c)}</button>`)
            .join("")}
        </div>`
      : "";

  return `${head(config.project.name, config.project.tagline || "arXiv 논문을 읽기 쉬운 블로그로", {
    canonicalUrl,
    siteName: config.project.name,
  })}
<body>
<a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
${siteHeader("./", config.project.name)}
<main id="main-content" class="home">
  <section class="home-hero" aria-labelledby="home-title">
    <span class="hero-badge">arXiv → 읽고 싶은 글</span>
    <h1 id="home-title">${escapeHtml(config.project.name)}</h1>
    <p class="hero-sub">${escapeHtml(config.project.tagline || "어려운 논문을, 읽고 싶은 글로.")}</p>
    <p class="hero-desc">학계 사람이 아니어도 술술 읽히도록 논문을 다시 씁니다. 전문용어엔 자동 주석을, 흐름엔 도식을 붙이고, 읽다 막히면 옆의 AI에게 바로 물어보세요.</p>
    <div class="hero-steps">
      <div class="step"><span class="step-n">1</span><b>논문 넣기</b><span>arXiv ID·URL 하나면 끝</span></div>
      <div class="step"><span class="step-n">2</span><b>블로그로 변환</b><span>주석·도식·요약 자동 생성</span></div>
      <div class="step"><span class="step-n">3</span><b>읽고 물어보기</b><span>맥락을 아는 AI 챗 내장</span></div>
    </div>
  </section>
  <section class="home-list" aria-labelledby="post-list-title">
    <div class="home-list-head">
      <h2 id="post-list-title" class="home-list-title">${posts.length ? `글 ${posts.length}편` : "글"}</h2>
      ${posts.length ? `<input id="post-search" class="post-search" type="search" placeholder="제목·요약·분야 검색…" aria-label="글 검색" aria-controls="cards search-status search-empty" autocomplete="off" enterkeyhint="search">` : ""}
    </div>
    ${catFilter}
    <div class="cards" id="cards" aria-labelledby="post-list-title">
      ${posts.length ? cards : empty}
    </div>
    <p id="search-status" class="search-status" role="status" aria-live="polite" aria-atomic="true"></p>
    <p id="search-empty" class="search-empty" hidden aria-hidden="true">검색 결과가 없습니다. 다른 검색어를 입력해 보세요.</p>
  </section>
</main>
<footer class="site-footer">arxiblog · arXiv 논문을 사람의 언어로</footer>
<script defer src="static/app.js"></script>
</body>
</html>`;
}

// ── 404 page ──

export function renderNotFoundPage(config: ArxiblogConfig): string {
  const basePath = publicBasePath(config.project.url);
  return `${head("404 · " + config.project.name, "페이지를 찾을 수 없습니다", {
    assetPrefix: basePath,
    noindex: true,
    siteName: config.project.name,
  })}
<body>
<a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
${siteHeader(basePath, config.project.name)}
<main id="main-content" class="notfound">
  <h1 class="notfound-code">404</h1>
  <p>찾으시는 페이지가 없습니다.</p>
  <p><a href="${basePath}">← 홈으로 돌아가기</a></p>
</main>
<script defer src="${basePath}static/app.js"></script>
</body>
</html>`;
}

// ── Admin page (served live in `serve` mode) ──

export function renderAdminPage(config: ArxiblogConfig): string {
  const personaOpts = `<option value="">인증 후 불러오기</option>`;
  const provOpts = ["gemini", "anthropic", "openai", "azure-openai"]
    .map((p) => `<option value="${p}">${p}</option>`)
    .join("");
  const levelOpts = [
    ["beginner", "입문"],
    ["intermediate", "중급"],
  ]
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join("");

  return `${head("관리 · " + config.project.name, "arxiblog 관리 페이지", {
    assetPrefix: "/",
    noindex: true,
    siteName: config.project.name,
  })}
<body class="admin-body">
<a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
${siteHeader("/", config.project.name)}
<main id="main-content" class="admin">
  <h1>관리</h1>
  <p id="auth-note" class="admin-note" role="status" aria-live="polite"></p>

  <section class="admin-card" aria-labelledby="add-title">
    <h2 id="add-title">📥 논문 추가</h2>
    <form id="add-form" aria-describedby="add-status">
      <label>arXiv ID 또는 URL
        <input id="add-source" name="source" inputmode="url" placeholder="2605.31264 또는 https://arxiv.org/abs/..." autocomplete="off" required>
      </label>
      <div class="row">
        <label>페르소나<select id="add-persona" name="persona">${personaOpts}</select></label>
        <label>난이도<select id="add-level" name="level">${levelOpts}</select></label>
      </div>
      <button type="submit">글 생성</button>
    </form>
    <div id="add-status" class="status" role="status" aria-live="polite" aria-atomic="true"></div>
  </section>

  <section class="admin-card" aria-labelledby="settings-title">
    <h2 id="settings-title">⚙️ 설정</h2>
    <form id="settings-form" aria-describedby="settings-status">
      <div class="row">
        <label>프로바이더<select id="set-provider" name="provider" aria-describedby="provider-change-warning">${provOpts}</select></label>
        <label>모델<input id="set-model" name="model" value="" autocomplete="off" required></label>
      </div>
      <p id="provider-change-warning" class="admin-note warn" role="alert" hidden>프로바이더를 변경하면 기존 API 키와 Endpoint가 삭제되고 모델 기본값이 바뀝니다. 새 프로바이더의 API 키와 모델을 확인해야 저장할 수 있습니다.</p>
      <label>API Key <input id="set-key" name="api-key" type="password" placeholder="인증 후 상태 확인" autocomplete="new-password" spellcheck="false" aria-describedby="provider-change-warning"></label>
      <label class="admin-check"><input id="set-clear-keys" name="clear-api-keys" type="checkbox"><span><b>저장된 API 키 모두 삭제</b><small>삭제 후 AI 기능은 새 키를 저장할 때까지 중단됩니다.</small></span></label>
      <label>Azure Endpoint <span class="hint">(azure-openai만)</span><input id="set-endpoint" name="endpoint" type="url" value="" autocomplete="off" spellcheck="false"></label>
      <div class="row">
        <label>기본 페르소나<select id="set-persona" name="active-persona">${personaOpts}</select></label>
        <label>기본 난이도<select id="set-level" name="default-level">${levelOpts}</select></label>
      </div>
      <button type="submit">설정 저장</button>
    </form>
    <div id="settings-status" class="status" role="status" aria-live="polite" aria-atomic="true"></div>
  </section>

  <section class="admin-card" aria-labelledby="admin-post-list-title">
    <h2 id="admin-post-list-title">📝 글 목록</h2>
    <div id="post-list" class="post-list" aria-live="polite" aria-busy="true">불러오는 중…</div>
  </section>
</main>
<script defer src="/static/app.js"></script>
<script>${adminScript()}</script>
</body>
</html>`;
}

function adminScript(): string {
  return `(function(){
"use strict";
var note=document.getElementById("auth-note");
var url=new URL(location.href);
var fragmentToken=url.hash.indexOf("#token=")===0?new URLSearchParams(url.hash.slice(1)).get("token"):"";
var suppliedToken=fragmentToken||url.searchParams.get("token");
var token="";
try{
  if(suppliedToken){
    sessionStorage.setItem("arxiblog-admin-token",suppliedToken);
    url.searchParams.delete("token");
    url.hash="";
    history.replaceState({},"",url.pathname+(url.searchParams.toString()?"?"+url.searchParams.toString():""));
  }
  token=sessionStorage.getItem("arxiblog-admin-token")||"";
}catch(_err){
  note.textContent="브라우저 저장소를 사용할 수 없어 관리자 인증을 유지할 수 없습니다.";
  note.className="admin-note warn";
}
if(!note.textContent){
  note.textContent=token?"인증 확인 중…":"⚠ 토큰이 없습니다. 콘솔에 출력된 /admin#token=... 주소로 접속하세요.";
  note.className=token?"admin-note":"admin-note warn";
}

function api(path,method,body){
  return fetch(path,{method:method||"GET",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:body?JSON.stringify(body):undefined});
}
async function readJson(response){
  try{return await response.json();}catch(_err){return {};}
}
function errorMessage(error){
  return error&&error.message?error.message:"알 수 없는 오류";
}
function setStatus(element,state,message){
  element.className="status "+state;
  element.textContent=message;
}
function setFormBusy(form,busy){
  form.setAttribute("aria-busy",String(busy));
  var button=form.querySelector('button[type="submit"]');
  if(button)button.disabled=busy||!token||!configLoaded;
}

var addForm=document.getElementById("add-form");
var setForm=document.getElementById("settings-form");
var providerSelect=document.getElementById("set-provider");
var keyInput=document.getElementById("set-key");
var providerWarning=document.getElementById("provider-change-warning");
var originalProvider="";
var originalModel="";
var configLoaded=false;
var providerDefaults={gemini:"gemini-3.1-flash-lite",anthropic:"claude-sonnet-4-6",openai:"gpt-5.4-nano","azure-openai":"gpt-5.4-nano"};
setFormBusy(addForm,true);
setFormBusy(setForm,true);
if(!token){
  setFormBusy(addForm,false);
  setFormBusy(setForm,false);
}

function providerChanged(){
  return Boolean(originalProvider&&providerSelect.value!==originalProvider);
}
function syncProviderWarning(){
  var changed=providerChanged();
  providerWarning.hidden=!changed;
  keyInput.setAttribute("aria-required",String(changed));
  var modelInput=document.getElementById("set-model");
  if(changed&&(modelInput.value===originalModel||!modelInput.value.trim()))modelInput.value=providerDefaults[providerSelect.value]||"";
  if(!changed&&originalModel)modelInput.value=originalModel;
}
providerSelect.addEventListener("change",syncProviderWarning);

function replaceOptions(select,items,value,label){
  select.replaceChildren();
  items.forEach(function(item){
    var option=document.createElement("option");
    option.value=item.name;
    option.textContent=label(item);
    option.selected=item.name===value;
    select.appendChild(option);
  });
}

async function loadSettings(){
  if(!token)return;
  try{
    var response=await api("/api/config","GET");
    var result=await readJson(response);
    if(!response.ok)throw new Error(result.error||String(response.status));
    originalProvider=result.provider||"gemini";
    providerSelect.value=originalProvider;
    syncProviderWarning();
    originalModel=result.model||"";
    document.getElementById("set-model").value=originalModel;
    document.getElementById("set-endpoint").value=result.endpoint||"";
    document.getElementById("set-key").placeholder=result.hasKey?"설정됨 — 변경할 때만 입력":"미설정";
    var personas=Array.isArray(result.personas)?result.personas:[];
    replaceOptions(document.getElementById("add-persona"),personas,result.active_persona,function(item){return item.name+" — "+(item.description||"");});
    replaceOptions(document.getElementById("set-persona"),personas,result.active_persona,function(item){return item.name+" — "+(item.description||"");});
    document.getElementById("add-level").value=result.default_level||"beginner";
    document.getElementById("set-level").value=result.default_level||"beginner";
    configLoaded=true;
    note.textContent="✓ 인증됨";
    note.className="admin-note ok";
    setFormBusy(addForm,false);
    setFormBusy(setForm,false);
  }catch(_error){
    try{sessionStorage.removeItem("arxiblog-admin-token");}catch(_err){}
    token="";
    note.textContent="⚠ 관리자 인증에 실패했습니다. 콘솔의 새 /admin#token=... 주소로 다시 접속하세요.";
    note.className="admin-note warn";
  }
}

addForm.addEventListener("submit",async function(event){
  event.preventDefault();
  var source=document.getElementById("add-source").value.trim();
  if(!source||!token)return;
  var status=document.getElementById("add-status");
  setFormBusy(addForm,true);
  setStatus(status,"busy","⏳ 논문을 가져와 글을 쓰는 중… (수십 초 걸릴 수 있어요)");
  try{
    var response=await api("/api/add","POST",{source:source,persona:document.getElementById("add-persona").value,level:document.getElementById("add-level").value});
    var result=await readJson(response);
    if(!response.ok||result.error){
      if(response.status===502||response.status===504){
        setStatus(status,"err","연결이 끝났지만 처리가 계속됐을 수 있습니다. 중복 비용을 피하려면 글 목록을 먼저 확인한 뒤 재시도하세요.");
      }else{
        setStatus(status,"err","오류: "+(result.error||response.status));
      }
    }else{
      status.className="status ok";
      status.textContent="✅ ";
      var link=document.createElement("a");
      link.href="/p/"+encodeURIComponent(result.slug)+".html";
      link.textContent=result.title||"생성한 글";
      status.appendChild(link);
      status.appendChild(document.createTextNode(" ("+(Number(result.annotations)||0)+"개 주석 · 참고용 예상 ~$"+(Number(result.cost)||0).toFixed(4)+")"));
      document.getElementById("add-source").value="";
      loadPosts();
    }
  }catch(_error){
    setStatus(status,"err","요청 연결이 끊겼지만 처리가 계속됐을 수 있습니다. 중복 비용을 피하려면 글 목록을 먼저 확인한 뒤 재시도하세요.");
  }finally{
    setFormBusy(addForm,false);
  }
});

setForm.addEventListener("submit",async function(event){
  event.preventDefault();
  if(!token)return;
  var status=document.getElementById("settings-status");
  var clearKeys=document.getElementById("set-clear-keys");
  if(clearKeys.checked&&keyInput.value){
    setStatus(status,"err","새 API 키 입력과 저장된 키 삭제를 동시에 선택할 수 없습니다.");
    return;
  }
  if(providerChanged()&&!keyInput.value){
    setStatus(status,"err","프로바이더를 변경하려면 새 프로바이더의 API 키를 입력하세요.");
    keyInput.focus();
    return;
  }
  if(providerChanged()&&!confirm("프로바이더를 변경하면 기존 API 키와 Endpoint가 삭제됩니다. 새 프로바이더로 변경할까요?"))return;
  var endpointInput=document.getElementById("set-endpoint").value.trim();
  var nextEndpoint=providerChanged()&&providerSelect.value!=="azure-openai"?"":endpointInput;
  var body={provider:providerSelect.value,model:document.getElementById("set-model").value.trim(),endpoint:nextEndpoint,active_persona:document.getElementById("set-persona").value,default_level:document.getElementById("set-level").value,clear_api_keys:clearKeys.checked};
  if(keyInput.value)body.api_key=keyInput.value;
  setFormBusy(setForm,true);
  setStatus(status,"busy","저장 중…");
  try{
    var response=await api("/api/settings","POST",body);
    var result=await readJson(response);
    if(response.ok&&!result.error){
      setStatus(status,"ok","✅ 저장됨");
      originalProvider=body.provider;
      originalModel=body.model;
      syncProviderWarning();
      keyInput.placeholder=clearKeys.checked?"미설정":(keyInput.value?"설정됨 — 변경할 때만 입력":keyInput.placeholder);
      keyInput.value="";
      clearKeys.checked=false;
    }else{
      setStatus(status,"err","오류: "+(result.error||response.status));
    }
  }catch(error){
    setStatus(status,"err","요청 실패: "+errorMessage(error));
  }finally{
    setFormBusy(setForm,false);
  }
});

async function deletePost(button,row,slug,title){
  if(!token||!confirm("‘"+title+"’ 글을 삭제할까요?"))return;
  button.disabled=true;
  button.textContent="삭제 중…";
  try{
    var response=await api("/api/delete","POST",{slug:slug});
    var result=await readJson(response);
    if(response.ok&&!result.error){
      await loadPosts();
      return;
    }
    throw new Error(result.error||String(response.status));
  }catch(error){
    button.disabled=false;
    button.textContent="다시 삭제";
    var failure=row.querySelector(".delete-error")||document.createElement("span");
    failure.className="status err delete-error";
    failure.setAttribute("role","alert");
    failure.textContent="삭제 실패: "+errorMessage(error);
    if(!failure.parentNode)row.appendChild(failure);
  }
}

async function loadPosts(){
  var list=document.getElementById("post-list");
  list.setAttribute("aria-busy","true");
  try{
    var response=await fetch("/api/posts");
    var result=await readJson(response);
    if(!response.ok)throw new Error(result.error||String(response.status));
    var posts=Array.isArray(result.posts)?result.posts:[];
    list.replaceChildren();
    if(!posts.length){
      var empty=document.createElement("p");
      empty.className="muted";
      empty.textContent="아직 글이 없습니다.";
      list.appendChild(empty);
      return;
    }
    posts.forEach(function(post){
      var row=document.createElement("div");
      row.className="post-row";
      var link=document.createElement("a");
      link.href="/p/"+encodeURIComponent(post.slug)+".html";
      link.textContent=post.title||"제목 없는 글";
      var meta=document.createElement("span");
      meta.className="muted";
      meta.textContent="arXiv:"+(post.arxiv_id||"")+" · "+(Number(post.reading_minutes)||0)+"분";
      var button=document.createElement("button");
      button.type="button";
      button.textContent="삭제";
      button.disabled=!token;
      button.setAttribute("aria-label","‘"+(post.title||"제목 없는 글")+"’ 삭제");
      button.addEventListener("click",function(){deletePost(button,row,post.slug,post.title||"제목 없는 글");});
      row.append(link,meta,button);
      list.appendChild(row);
    });
  }catch(_error){
    list.textContent="목록을 불러오지 못했습니다. 페이지를 새로고침해 주세요.";
  }finally{
    list.setAttribute("aria-busy","false");
  }
}
loadSettings();
loadPosts();
})();`;
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
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x != null).map(String).filter((x) => x.trim() !== "");
  } catch {
    return [];
  }
}

/** Parse a JSON array of objects (e.g. key_references); returns [] on any malformed input. */
function safeParseObjectArray<T>(s: string | undefined): T[] {
  try {
    const v = JSON.parse(s || "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is T => !!x && typeof x === "object" && !Array.isArray(x));
  } catch {
    return [];
  }
}
