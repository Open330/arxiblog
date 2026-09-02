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
    expect(postHtml).toContain('src="../static/vendor/mermaid/mermaid.min.js"');
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
    expect(readdirSync(join(outputDir, "static", "vendor", "mermaid")).sort()).toEqual([
      "LICENSE.txt",
      "mermaid.min.js",
    ]);

    // Fontsource's historical filename says "latin", but these exact artifacts
    // are byte-identical to Pretendard 1.3.9's full upstream Korean WOFF2 faces
    // (14,336 mapped code points, including all 11,172 modern Hangul syllables).
    const pretendardDir = join(outputDir, "static", "vendor", "pretendard");
    const fontDigests: Record<string, string> = {
      "Pretendard-Regular.woff2": "fad853f7f47c6c8b103171e7193fa095708cdcd70850a71d93aa5379e8a61d63",
      "Pretendard-Bold.woff2": "4609c3356e536fafe38f4add0daeceb3d8595d3057bce13c428c33ddbd43d362",
    };
    for (const [fileName, expectedDigest] of Object.entries(fontDigests)) {
      const fontPath = join(pretendardDir, fileName);
      expect(statSync(fontPath).size).toBeGreaterThan(700_000);
      expect(createHash("sha256").update(readFileSync(fontPath)).digest("hex")).toBe(expectedDigest);
    }

    expect(readFileSync(join(pretendardDir, "LICENSE.txt"), "utf-8")).toContain("SIL OPEN FONT LICENSE");
    expect(readFileSync(join(outputDir, "static", "vendor", "katex", "LICENSE.txt"), "utf-8"))
      .toContain("The MIT License");
    expect(readFileSync(join(outputDir, "static", "vendor", "mermaid", "LICENSE.txt"), "utf-8"))
      .toContain("The MIT License");
  });

  test("each post loads only the rich renderer it actually needs", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-conditional-assets-"));
    temporaryRoots.push(root);
    const posts = [
      post("plain", "가격은 $5, $10입니다. `코드 $x$ [[term]]`\n\n```ts\nconst x = '$y$ [[term]]';\n```\n\n````md\n```mermaid\nA --> B\n```\n````"),
      post("math", "인라인 $x+y$ 수식"),
      post("diagram", "~~~mermaid\nflowchart TD\n  A --> B\n~~~~"),
      post("both", "$$x^2$$\n\n```mermaid\nsequenceDiagram\n  A->>B: hello\n```"),
    ];
    await buildSite({ listPosts: () => posts, getAnnotations: () => [] }, defaultConfig("Conditional"), root);
    const readPost = (slug: string) => readFileSync(join(root, "_site", "p", `${slug}.html`), "utf-8");
    const plain = readPost("plain");
    const math = readPost("math");
    const diagram = readPost("diagram");
    const both = readPost("both");

    expect(plain).not.toContain("vendor/katex");
    expect(plain).not.toContain("vendor/mermaid");
    expect(plain).not.toContain("static/rich.js");
    expect(math).toContain("vendor/katex/katex.min.js");
    expect(math).not.toContain("vendor/mermaid");
    expect(diagram).not.toContain("vendor/katex");
    expect(diagram).toContain("vendor/mermaid/mermaid.min.js");
    expect(diagram.indexOf("static/app.js")).toBeLessThan(diagram.indexOf("vendor/mermaid/mermaid.min.js"));
    expect(both).toContain("vendor/katex/katex.min.js");
    expect(both).toContain("vendor/mermaid/mermaid.min.js");

    const plainRoot = mkdtempSync(join(tmpdir(), "arxiblog-plain-assets-"));
    temporaryRoots.push(plainRoot);
    await buildSite(
      { listPosts: () => [post("plain-only", "외부 렌더러가 필요 없는 글")], getAnnotations: () => [] },
      defaultConfig("Plain only"),
      plainRoot
    );
    expect(existsSync(join(plainRoot, "_site", "static", "vendor", "katex"))).toBe(false);
    expect(existsSync(join(plainRoot, "_site", "static", "vendor", "mermaid"))).toBe(false);
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
