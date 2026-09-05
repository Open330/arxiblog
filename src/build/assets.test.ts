import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import packageJson from "../../package.json";
import { defaultConfig } from "../config";
import { Store, type Post } from "../store";
import { buildSite, renderPostBody } from "./renderer";
import { renderAdminPage } from "./templates";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function localOutputPath(outputDir: string, htmlPath: string, reference: string): string {
  if (reference.startsWith("/docs/")) return join(outputDir, reference.slice("/docs/".length));
  return resolve(dirname(htmlPath), reference);
}

function resourceReferences(html: string): string[] {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const styles = [...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"/g)]
    .map((match) => match[1]);
  return [...scripts, ...styles];
}

/** Every application/ld+json payload on a page, flattened. */
function structuredData(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((match) => {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function post(slug: string, content: string): Post {
  return {
    id: slug.length,
    paper_id: slug.length,
    slug,
    title: slug,
    subtitle: "",
    tldr: "",
    takeaways: "[]",
    level: "beginner",
    reading_minutes: 1,
    content,
    persona: "friendly",
    created_at: "2026-01-01",
    contributions: "[]",
    strengths: "[]",
    limitations: "[]",
    prerequisites: "[]",
    who_should_read: "",
    suggested_questions: "[]",
    key_references: "[]",
    figures: "[]",
    translation_en: "",
    reviewed_at: "2026-01-01T00:00:00.000Z",
  verify_notes: "",
    paper_title: slug,
    arxiv_id: `2601.${String(slug.length).padStart(5, "0")}`,
    categories: "cs.SE",
  };
}

describe("offline static assets", () => {
  test("asset packages are exact pins", () => {
    expect(packageJson.dependencies["@fontsource/pretendard"]).toBe("5.2.5");
    expect(packageJson.dependencies.katex).toBe("0.16.47");
    expect(packageJson.dependencies.mermaid).toBe("11.16.0");
    expect(packageJson.dependencies["pdf-parse"]).toBe("1.1.4");
    expect(packageJson.files).toContain("scripts/**/*");
  });

  test("generated pages reference a complete local-only asset set", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-assets-"));
    temporaryRoots.push(root);
    const store = new Store(join(root, "test.db"));
    const config = defaultConfig("Offline docs");
    config.project.url = "https://example.test/docs";
    try {
      const paper = store.upsertPaper({
        arxiv_id: "2601.00001",
        title: "Offline rendering",
        authors: "Test Author",
        abstract: "Asset smoke test",
        categories: "cs.SE",
        published: "2026-01-01",
        abs_url: "https://arxiv.org/abs/2601.00001",
        pdf_url: "https://arxiv.org/pdf/2601.00001",
        raw_text: "test",
      });
      store.upsertPost({
        paper_id: paper.id,
        slug: "offline-rendering",
        title: "오프라인 렌더링",
        subtitle: "Local assets only",
        tldr: "수식과 도식을 네트워크 없이 표시합니다.",
        takeaways: [],
        level: "beginner",
        reading_minutes: 1,
        content: "## 수식과 도식\n\n$E=mc^2$\n\n```mermaid\nflowchart TD\n  A --> B\n```",
        persona: "friendly",
      });

      await buildSite(store, config, root);
    } finally {
      store.close();
    }

    const outputDir = join(root, "_site");
    const pages = [
      join(outputDir, "index.html"),
      join(outputDir, "404.html"),
      join(outputDir, "p", "offline-rendering.html"),
    ];

    for (const htmlPath of pages) {
      const html = readFileSync(htmlPath, "utf-8");
      expect(html).not.toContain("cdn.jsdelivr.net");
      expect(html).not.toContain('rel="preconnect"');
      for (const reference of resourceReferences(html)) {
        expect(reference).not.toMatch(/^https?:\/\//);
        expect(existsSync(localOutputPath(outputDir, htmlPath, reference))).toBe(true);
      }
    }

    const postHtml = readFileSync(pages[2], "utf-8");
    expect(postHtml).toContain('href="../static/vendor/katex/katex.min.css"');
    // The diagram was rendered at build time, so the ~3.4 MB runtime library is
    // neither referenced nor copied; rich.js still supplies the pan/zoom viewport.
    expect(postHtml).not.toContain("vendor/mermaid");
    expect(postHtml).toContain('<div class="mermaid-figure" data-mermaid="prerendered">');
    expect(postHtml).toContain('class="mermaid-theme mermaid-theme-light"');
    expect(postHtml).toContain('class="mermaid-theme mermaid-theme-dark"');
    expect(postHtml).not.toContain('<pre class="mermaid">');
    expect(postHtml).toContain('src="../static/rich.js"');
    expect(postHtml).toContain("질문·최근 대화·현재 글 맥락이 설정된 외부 AI 제공자에게 전송됩니다.");
    expect(postHtml).toContain('aria-describedby="chat-privacy"');

    const fontsCssPath = join(outputDir, "static", "fonts.css");
    const katexCssPath = join(outputDir, "static", "vendor", "katex", "katex.min.css");
    for (const cssPath of [fontsCssPath, katexCssPath]) {
      const css = readFileSync(cssPath, "utf-8");
      expect(css).not.toMatch(/url\(["']?https?:\/\//);
      for (const match of css.matchAll(/url\(["']?([^)'\"]+)["']?\)/g)) {
        expect(existsSync(resolve(dirname(cssPath), match[1]))).toBe(true);
      }
    }

    const katexCss = readFileSync(katexCssPath, "utf-8");
    expect(katexCss).not.toMatch(/\.woff["')]/);
    expect(katexCss).not.toMatch(/\.ttf["')]/);
    expect(existsSync(join(outputDir, "static", "vendor", "mermaid"))).toBe(false);

    // The build ships Pretendard from its own origin in whichever form is
    // available — unicode-range chunks when the split package is installed, the
    // two full faces otherwise. fonts.test.ts pins the chunking itself; here the
    // only claim is that the stylesheet the site serves is backed by real local
    // files. The url-resolution loop above already proved every reference exists.
    const pretendardDir = join(outputDir, "static", "vendor", "pretendard");
    const fontsCss = readFileSync(fontsCssPath, "utf-8");
    const referenced = [...fontsCss.matchAll(/url\(["']?([^)'"]+\.woff2)["']?\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const url of referenced) {
      expect(url).not.toMatch(/^https?:/);
      expect(statSync(resolve(dirname(fontsCssPath), url)).size).toBeGreaterThan(0);
    }

    expect(readFileSync(join(pretendardDir, "LICENSE.txt"), "utf-8")).toContain("SIL OPEN FONT LICENSE");
    expect(readFileSync(join(outputDir, "static", "vendor", "katex", "LICENSE.txt"), "utf-8"))
      .toContain("The MIT License");
  }, 60_000);   // drives Chromium: measured 3-5s, over bun's 5s default. The
  // pre-render pass is internally capped (see totalBudgetMs), so this ceiling
  // only absorbs a slow cold start — it can no longer hide a hang.

  test("diagrams render to inline SVG instead of shipping mermaid.js", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-mermaid-prerender-"));
    temporaryRoots.push(root);
    const posts = [
      post("ok", "```mermaid\nflowchart TD\n  A[시작 지점] --> B{판단}\n```"),
      post("broken", "```mermaid\n((( not a diagram\n```"),
    ];
    await buildSite(
      { listPosts: () => posts, getAnnotations: () => [] },
      { ...defaultConfig("Prerender"), chat: { enabled: false } },
      root
    );
    const read = (slug: string) => readFileSync(join(root, "_site", "p", `${slug}.html`), "utf-8");

    const ok = read("ok");
    expect(ok).not.toContain("vendor/mermaid");
    expect(ok).toContain("mermaid-theme-light");
    expect(ok).toContain("mermaid-theme-dark");
    // Both colour schemes must lay out identically so one pan/zoom viewport fits
    // the pair and a theme switch needs no JavaScript.
    const viewBoxes = [...ok.matchAll(/<svg[^>]*\bviewBox="([^"]+)"/g)].map((m) => m[1]);
    expect(viewBoxes.length).toBe(2);
    expect(viewBoxes[0]).toBe(viewBoxes[1]);
    // The inlined SVG bypasses the Markdown sanitizer, so it must be inert.
    const figure = ok.slice(ok.indexOf(`<div class="mermaid-figure"`), ok.indexOf("</article>"));
    expect(figure).toContain("<svg");
    expect(figure).not.toMatch(/<script|<foreignObject|javascript:|\son[a-z]+\s*=/i);

    // A diagram mermaid itself rejects would fail in the reader's browser too, so
    // it gets a static fallback rather than dragging the 3.4 MB library back in
    // for the whole site.
    const broken = read("broken");
    expect(broken).not.toContain("vendor/mermaid");
    expect(broken).not.toContain('<pre class="mermaid">');
    expect(broken).toContain('<figure class="mermaid-unavailable">');
    expect(broken).toContain("도식을 표시할 수 없습니다");
    expect(broken).toContain("((( not a diagram");
    // One broken diagram must not cost the other pages their saving.
    expect(existsSync(join(root, "_site", "static", "vendor", "mermaid"))).toBe(false);
  }, 60_000);   // drives Chromium: measured 3-5s, over bun's 5s default. The
  // pre-render pass is internally capped (see totalBudgetMs), so this ceiling
  // only absorbs a slow cold start — it can no longer hide a hang.

  test("an unparseable diagram is reported against its slug", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-mermaid-warning-"));
    temporaryRoots.push(root);
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      await buildSite(
        {
          listPosts: () => [post("gan-post", "```mermaid\nflowchart TD\n  D[판별자] <-- I\n```")],
          getAnnotations: () => [],
        },
        { ...defaultConfig("Warning"), chat: { enabled: false } },
        root
      );
    } finally {
      console.warn = original;
    }
    const reported = warnings.filter((line) => line.includes("도식을 렌더링하지 못했습니다"));
    expect(reported.length).toBe(1);
    expect(reported[0]).toContain("p/gan-post.html");
    expect(reported[0]).toContain("flowchart TD");
    // Nothing renderable is left, so neither the library nor rich.js ships.
    expect(existsSync(join(root, "_site", "static", "vendor", "mermaid"))).toBe(false);
    expect(readFileSync(join(root, "_site", "p", "gan-post.html"), "utf-8")).not.toContain("static/rich.js");
  }, 60_000);   // drives Chromium: measured 3-5s, over bun's 5s default. The
  // pre-render pass is internally capped (see totalBudgetMs), so this ceiling
  // only absorbs a slow cold start — it can no longer hide a hang.

  test("a stalled pre-render pass degrades instead of hanging the build", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-mermaid-budget-"));
    temporaryRoots.push(root);
    // A budget this small guarantees the pass runs out of time. The build must
    // still finish — a hang here would block `digest` and the live /api/add
    // server, not just this test.
    const previous = process.env.ARXIBLOG_MERMAID_TIMEOUT_MS;
    process.env.ARXIBLOG_MERMAID_TIMEOUT_MS = "1";
    const started = Date.now();
    try {
      await buildSite(
        { listPosts: () => [post("stalled", "```mermaid\nflowchart TD\n  A --> B\n```")], getAnnotations: () => [] },
        { ...defaultConfig("Budget"), chat: { enabled: false } },
        root
      );
    } finally {
      if (previous === undefined) delete process.env.ARXIBLOG_MERMAID_TIMEOUT_MS;
      else process.env.ARXIBLOG_MERMAID_TIMEOUT_MS = previous;
    }
    expect(Date.now() - started).toBeLessThan(45_000);
    // Running out of time says nothing about the diagram, so it keeps the
    // runtime renderer rather than being written off as broken content.
    const html = readFileSync(join(root, "_site", "p", "stalled.html"), "utf-8");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).not.toContain("mermaid-unavailable");
    expect(html).toContain("vendor/mermaid/mermaid.min.js");
    expect(existsSync(join(root, "_site", "static", "vendor", "mermaid", "mermaid.min.js"))).toBe(true);
  }, 60_000);   // drives Chromium: measured 3-5s, over bun's 5s default. The
  // pre-render pass is internally capped (see totalBudgetMs), so this ceiling
  // only absorbs a slow cold start — it can no longer hide a hang.

  test("ARXIBLOG_MERMAID_PRERENDER=0 falls back to the runtime renderer", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-mermaid-runtime-"));
    temporaryRoots.push(root);
    const previous = process.env.ARXIBLOG_MERMAID_PRERENDER;
    process.env.ARXIBLOG_MERMAID_PRERENDER = "0";
    try {
      await buildSite(
        { listPosts: () => [post("runtime", "```mermaid\nflowchart TD\n  A --> B\n```")], getAnnotations: () => [] },
        { ...defaultConfig("Runtime mermaid"), chat: { enabled: false } },
        root
      );
    } finally {
      if (previous === undefined) delete process.env.ARXIBLOG_MERMAID_PRERENDER;
      else process.env.ARXIBLOG_MERMAID_PRERENDER = previous;
    }
    const html = readFileSync(join(root, "_site", "p", "runtime.html"), "utf-8");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("vendor/mermaid/mermaid.min.js");
    expect(html).toContain("static/rich.js");
    expect(existsSync(join(root, "_site", "static", "vendor", "mermaid", "mermaid.min.js"))).toBe(true);
  });

  test("each post loads only the rich renderer it actually needs", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-conditional-assets-"));
    temporaryRoots.push(root);
    const posts = [
      post("plain", "가격은 $5, $10입니다. `코드 $x$ [[term]]`\n\n```ts\nconst x = '$y$ [[term]]';\n```\n\n````md\n```mermaid\nA --> B\n```\n````"),
      post("math", "인라인 $x+y$ 수식"),
      post("diagram", "~~~mermaid\nflowchart TD\n  A --> B\n~~~~"),
      post("unparseable", "```mermaid\nflowchart TD\n  D[판별자] <-- I\n```"),
      post("both", "$$x^2$$\n\n```mermaid\nsequenceDiagram\n  A->>B: hello\n```"),
    ];
    // Disable chat so this checks the body-driven renderer selection in isolation
    // (chat enabled would load KaTeX on every post for chat math — covered below).
    const noChat = { ...defaultConfig("Conditional"), chat: { enabled: false } };
    await buildSite({ listPosts: () => posts, getAnnotations: () => [] }, noChat, root);
    const readPost = (slug: string) => readFileSync(join(root, "_site", "p", `${slug}.html`), "utf-8");
    const plain = readPost("plain");
    const math = readPost("math");
    const diagram = readPost("diagram");
    const unparseable = readPost("unparseable");
    const both = readPost("both");

    expect(plain).not.toContain("vendor/katex");
    expect(plain).not.toContain("vendor/mermaid");
    expect(plain).not.toContain("static/rich.js");
    expect(plain).not.toContain("mermaid-figure");
    expect(math).toContain("vendor/katex/katex.min.js");
    expect(math).not.toContain("vendor/mermaid");
    expect(math).not.toContain("mermaid-figure");
    // Diagrams arrive as inline SVG; only rich.js (the pan/zoom viewport) loads.
    expect(diagram).not.toContain("vendor/katex");
    expect(diagram).not.toContain("vendor/mermaid");
    expect(diagram).toContain("mermaid-figure");
    expect(diagram).toContain("static/rich.js");
    expect(both).toContain("vendor/katex/katex.min.js");
    expect(both).not.toContain("vendor/mermaid");
    expect(both).toContain("mermaid-figure");
    expect(both.indexOf("static/app.js")).toBeLessThan(both.indexOf("static/rich.js"));
    // A diagram that cannot be parsed loads neither renderer.
    expect(unparseable).toContain("mermaid-unavailable");
    expect(unparseable).not.toContain("vendor/mermaid");
    expect(unparseable).not.toContain("static/rich.js");
    expect(existsSync(join(root, "_site", "static", "vendor", "mermaid"))).toBe(false);

    const plainRoot = mkdtempSync(join(tmpdir(), "arxiblog-plain-assets-"));
    temporaryRoots.push(plainRoot);
    await buildSite(
      { listPosts: () => [post("plain-only", "외부 렌더러가 필요 없는 글")], getAnnotations: () => [] },
      { ...defaultConfig("Plain only"), chat: { enabled: false } },
      plainRoot
    );
    expect(existsSync(join(plainRoot, "_site", "static", "vendor", "katex"))).toBe(false);
    expect(existsSync(join(plainRoot, "_site", "static", "vendor", "mermaid"))).toBe(false);

    // With chat enabled (the default), post pages load KaTeX so chat answers can
    // render math even when the body has none — but not rich.js (body-only).
    const chatRoot = mkdtempSync(join(tmpdir(), "arxiblog-chat-assets-"));
    temporaryRoots.push(chatRoot);
    await buildSite(
      { listPosts: () => [post("chat-only", "수식 없는 본문이지만 챗은 켜져 있음")], getAnnotations: () => [] },
      defaultConfig("Chat only"),
      chatRoot
    );
    const chatOnly = readFileSync(join(chatRoot, "_site", "p", "chat-only.html"), "utf-8");
    expect(chatOnly).toContain("vendor/katex/katex.min.js");
    expect(chatOnly).not.toContain("static/rich.js");
    expect(existsSync(join(chatRoot, "_site", "static", "vendor", "katex"))).toBe(true);
  }, 60_000);   // drives Chromium: measured 3-5s, over bun's 5s default. The
  // pre-render pass is internally capped (see totalBudgetMs), so this ceiling
  // only absorbs a slow cold start — it can no longer hide a hang.


  test("post pages expose BlogPosting structured data", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-jsonld-post-"));
    temporaryRoots.push(root);
    const config = defaultConfig("Structured");
    config.project.url = "https://example.test/docs";
    const p = post("structured", "본문");
    p.title = '제목 </script><script>alert(1)</script> & "따옴표"';
    p.subtitle = "구조화 데이터 설명";
    p.arxiv_id = "2106.09685v2";
    await buildSite({ listPosts: () => [p], getAnnotations: () => [] }, config, root);
    const html = readFileSync(join(root, "_site", "p", "structured.html"), "utf-8");

    // Author text must never close the ld+json element or inject markup.
    const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(raw).not.toBeNull();
    expect(raw![1]).not.toContain("<");
    expect(raw![1]).not.toContain(">");

    const [data] = structuredData(html);
    expect(data["@type"]).toBe("BlogPosting");
    expect(data.headline).toBe(p.title);
    expect(data.description).toBe("구조화 데이터 설명");
    expect(data.datePublished).toBe("2026-01-01");
    expect(data.author.name).toBe("Structured");
    expect(data.isBasedOn).toBe("https://arxiv.org/abs/2106.09685v2");
    expect(data.mainEntityOfPage["@id"]).toBe("https://example.test/docs/p/structured.html");
    expect(data.url).toBe("https://example.test/docs/p/structured.html");
    expect(data.image).toBe("https://example.test/docs/og/structured.svg");
    expect(data.inLanguage).toBe("ko");
    expect(data.keywords).toEqual(["cs.SE"]);
    // Empty fields are dropped rather than published blank.
    expect("dateModified" in data).toBe(true);
    const withoutUrl = defaultConfig("No URL");
    const otherRoot = mkdtempSync(join(tmpdir(), "arxiblog-jsonld-nourl-"));
    temporaryRoots.push(otherRoot);
    await buildSite({ listPosts: () => [post("plain", "본문")], getAnnotations: () => [] }, withoutUrl, otherRoot);
    const [bare] = structuredData(readFileSync(join(otherRoot, "_site", "p", "plain.html"), "utf-8"));
    expect("mainEntityOfPage" in bare).toBe(false);
    expect("url" in bare).toBe(false);
    expect("image" in bare).toBe(false);
  });

  test("the home listing paginates with correct canonical, prev/next and structured data", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-pagination-"));
    temporaryRoots.push(root);
    const config = defaultConfig("Paged");
    config.project.url = "https://example.test/docs";
    const posts = Array.from({ length: 25 }, (_unused, index) => {
      const p = post(`post-${String(index).padStart(2, "0")}`, "본문");
      p.title = `글 ${index}`;
      return p;
    });
    await buildSite({ listPosts: () => posts, getAnnotations: () => [] }, config, root);
    const site = join(root, "_site");
    const home = readFileSync(join(site, "index.html"), "utf-8");
    const second = readFileSync(join(site, "page", "2.html"), "utf-8");
    const third = readFileSync(join(site, "page", "3.html"), "utf-8");
    expect(existsSync(join(site, "page", "4.html"))).toBe(false);

    const cardCount = (html: string) => [...html.matchAll(/<a class="card"/g)].length;
    expect(cardCount(home)).toBe(12);
    expect(cardCount(second)).toBe(12);
    expect(cardCount(third)).toBe(1);

    expect(home).toContain('<link rel="canonical" href="https://example.test/docs/">');
    expect(home).toContain('<link rel="next" href="https://example.test/docs/page/2.html">');
    expect(home).not.toContain('rel="prev"');
    expect(second).toContain('<link rel="canonical" href="https://example.test/docs/page/2.html">');
    expect(second).toContain('<link rel="prev" href="https://example.test/docs/">');
    expect(second).toContain('<link rel="next" href="https://example.test/docs/page/3.html">');
    expect(third).toContain('<link rel="canonical" href="https://example.test/docs/page/3.html">');
    expect(third).not.toContain('rel="next"');

    // Page 2+ sits one directory deep: every reference has to shift with it.
    expect(second).toContain('href="../p/post-12.html"');
    expect(second).toContain('src="../static/app.js"');
    expect(second).toContain('data-post-index="../posts.json"');
    for (const reference of resourceReferences(second)) {
      expect(existsSync(localOutputPath(site, join(site, "page", "2.html"), reference))).toBe(true);
    }

    // In-page navigation stays relative so the site works from any base path.
    expect(home).toContain('<a class="pager-link pager-next" href="page/2.html" rel="next">');
    expect(second).toContain('<a class="pager-link pager-prev" href="../" rel="prev">');
    expect(second).toContain('<a class="pager-link pager-next" href="3.html" rel="next">');

    // The head count and category chips describe the whole corpus, not one page.
    expect(home).toContain("글 25편");
    expect(second).toContain("글 25편");

    const [blog, itemList] = structuredData(second);
    expect(blog["@type"]).toBe("Blog");
    expect(blog.url).toBe("https://example.test/docs/");
    expect(itemList["@type"]).toBe("ItemList");
    expect(itemList.numberOfItems).toBe(25);
    expect(itemList.itemListElement.length).toBe(12);
    // Positions continue across pages instead of restarting.
    expect(itemList.itemListElement[0].position).toBe(13);
    expect(itemList.itemListElement[0].url).toBe("https://example.test/docs/p/post-12.html");
    expect(structuredData(home)[1].itemListElement[0].position).toBe(1);

    const sitemap = readFileSync(join(site, "sitemap.xml"), "utf-8");
    expect(sitemap).toContain("<loc>https://example.test/docs/page/2.html</loc>");
    expect(sitemap).toContain("<loc>https://example.test/docs/page/3.html</loc>");
    expect(sitemap).not.toContain("page/4.html");
  });

  test("a single-page home has no pager and no page directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-single-page-"));
    temporaryRoots.push(root);
    await buildSite(
      { listPosts: () => [post("only", "본문")], getAnnotations: () => [] },
      defaultConfig("Single"),
      root
    );
    const home = readFileSync(join(root, "_site", "index.html"), "utf-8");
    expect(home).not.toContain('class="pager"');
    expect(home).not.toContain('rel="next"');
    expect(existsSync(join(root, "_site", "page"))).toBe(false);
    expect(home).toContain('data-post-index="posts.json"');
  });

  test("versioned arXiv links keep the requested PDF revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-versioned-link-"));
    temporaryRoots.push(root);
    const versioned = post("versioned", "본문");
    versioned.arxiv_id = "2106.09685v2";
    await buildSite(
      { listPosts: () => [versioned], getAnnotations: () => [] },
      defaultConfig("Versioned"),
      root
    );
    const html = readFileSync(join(root, "_site", "p", "versioned.html"), "utf-8");
    expect(html).toContain('href="https://arxiv.org/pdf/2106.09685v2"');
  });

  test("literal code never becomes math or an annotation", async () => {
    const html = await renderPostBody(
      "`$inline$ [[term]]`\n\n```ts\nconst sample = '$block$ [[term]]';\n````\n\n    const indented = '$code$ [[term]]';",
      [{ id: 1, post_id: 1, term: "term", kind: "jargon", explanation: "설명" }]
    );
    expect(html).toContain("$inline$ [[term]]");
    expect(html).toContain("$block$ [[term]]");
    expect(html).toContain("$code$ [[term]]");
    expect(html).not.toContain('class="annot"');
  });

  test("a Mermaid fence interrupts prose without invalid paragraph nesting", async () => {
    const html = await renderPostBody(
      "before\n```mermaid\nflowchart TD\n  A --> B\n```\nafter",
      []
    );
    expect(html).toContain("<p>before</p>");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("<p>after</p>");
    expect(html).not.toMatch(/<p>[^<]*<pre class="mermaid">/);
  });

  test("code protection preserves normal paragraph and tight-list semantics", async () => {
    const paragraph = await renderPostBody("paragraph\n    continuation", []);
    expect(paragraph).toContain("<p>paragraph\n    continuation</p>");
    expect(paragraph).not.toContain("<pre>");

    const list = await renderPostBody("- item\n  ```js\n  code\n  ```\n  after", []);
    expect(list).toContain("<li>item<pre><code class=\"language-js\">code");
    expect(list).toContain("</code></pre>\nafter</li>");
    expect(list).not.toContain("<li><p>");
  });

  test("post bodies remove remote images but preserve external links", async () => {
    const html = await renderPostBody(
      "![tracking](https://tracker.example/pixel.gif)\n\n<img src=\"https://tracker.example/raw.gif\" alt=\"raw\">\n\n[공식 문서](https://example.test/docs)",
      []
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain('href="https://example.test/docs"');
  });

  test("sitemap and robots share sanitized public URL handling", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-sitemap-assets-"));
    temporaryRoots.push(root);
    const config = defaultConfig("Sitemap");
    config.project.url = "https://example.test/papers&notes?utm=secret#section";
    await buildSite({ listPosts: () => [], getAnnotations: () => [] }, config, root);
    const robots = readFileSync(join(root, "_site", "robots.txt"), "utf-8");
    const sitemap = readFileSync(join(root, "_site", "sitemap.xml"), "utf-8");
    expect(robots).toContain("Sitemap: https://example.test/papers&notes/sitemap.xml");
    expect(robots).not.toContain("utm=secret");
    expect(robots).not.toContain("#section");
    expect(sitemap).toContain("<loc>https://example.test/papers&amp;notes/</loc>");

    config.project.url = "javascript:alert(1)";
    await buildSite({ listPosts: () => [], getAnnotations: () => [] }, config, root);
    expect(readFileSync(join(root, "_site", "robots.txt"), "utf-8")).not.toContain("Sitemap:");
    expect(existsSync(join(root, "_site", "sitemap.xml"))).toBe(false);
  });

  test("admin shell contains no private config and supports fragment auth/key clearing", () => {
    const config = defaultConfig("Admin shell");
    config.llm.provider = "azure-openai";
    config.llm.model = "private-model-name";
    config.llm.endpoint = "https://private-endpoint.example";
    config.llm.api_key = "secret-key";
    config.personas = [{ name: "private-persona", description: "secret", audience: "a", style: "s" }];
    const html = renderAdminPage(config);
    expect(html).not.toContain("private-model-name");
    expect(html).not.toContain("private-endpoint.example");
    expect(html).not.toContain("secret-key");
    expect(html).not.toContain("private-persona");
    expect(html).toContain("#token=");
    expect(html).toContain('api("/api/config","GET")');
    expect(html).toContain('id="set-clear-keys"');
    expect(html).toContain("clear_api_keys:clearKeys.checked");
    expect(html).toContain('id="provider-change-warning"');
    expect(html).toContain("프로바이더를 변경하려면 새 프로바이더의 API 키를 입력하세요");
    expect(html).toContain('keyInput.focus()');
    expect(html).toContain('confirm("프로바이더를 변경하면 기존 API 키와 Endpoint가 삭제됩니다.');
    expect(html).toContain("글 목록을 먼저 확인한 뒤 재시도하세요");
  });
});
