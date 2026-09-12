import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultConfig, gaMeasurementId, loadConfig, saveConfig } from "../config";
import { CONTENT_SECURITY_POLICY } from "../server";
import { Store, type Post } from "../store";
import { buildSite } from "./renderer";
import { analyticsSnippet, renderIndexPage, renderNotFoundPage, renderPostPage } from "./templates";

const MEASUREMENT_ID = "G-TEST1234AB";
const GTAG_LOADER = `<script async src="https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}"></script>`;
const GTAG_CONFIG = `gtag('config','${MEASUREMENT_ID}')`;

const temporaryRoots: string[] = [];
afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function samplePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 1,
    paper_id: 1,
    slug: "sample-post",
    title: "샘플 <제목>",
    subtitle: "부제목 & 설명",
    tldr: "요약",
    takeaways: "[]",
    level: "beginner",
    reading_minutes: 3,
    content: "## 본문\n\n내용",
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
    paper_title: "Sample paper",
    arxiv_id: "2601.00001",
    categories: "cs.SE",
    ...overrides,
  };
}

function headOf(html: string): string {
  return html.slice(0, html.indexOf("</head>"));
}

function renderPost(config = defaultConfig("Paper Notes"), ogImage = ""): string {
  return renderPostPage({
    config,
    post: samplePost(),
    bodyHtml: "<p>본문</p>",
    toc: [],
    annotations: [],
    ogImage,
  });
}

describe("analytics snippet", () => {
  test("is omitted unless a valid GA4 measurement ID is configured", () => {
    expect(analyticsSnippet(undefined)).toBe("");
    expect(analyticsSnippet("")).toBe("");
    expect(analyticsSnippet("UA-12345-1")).toBe("");
    expect(analyticsSnippet("G-ABC'><script>alert(1)</script>")).toBe("");
    expect(analyticsSnippet(MEASUREMENT_ID)).toContain(GTAG_LOADER);
    expect(analyticsSnippet(MEASUREMENT_ID)).toContain(GTAG_CONFIG);
  });

  test("gaMeasurementId normalises and validates the configured value", () => {
    const config = defaultConfig("Paper Notes");
    expect(gaMeasurementId(config)).toBe("");
    config.analytics = { ga_measurement_id: "" };
    expect(gaMeasurementId(config)).toBe("");
    config.analytics = { ga_measurement_id: "  g-test1234ab " };
    expect(gaMeasurementId(config)).toBe(MEASUREMENT_ID);
    config.analytics = { ga_measurement_id: "G-<bad>" };
    expect(gaMeasurementId(config)).toBe("");
  });

  test("pages carry no gtag markup by default", () => {
    const config = defaultConfig("Paper Notes");
    for (const html of [renderIndexPage({ config, posts: [samplePost()] }), renderPost(config), renderNotFoundPage(config)]) {
      expect(html).not.toContain("googletagmanager.com");
      expect(html).not.toContain("gtag(");
    }
  });

  test("every public page gets the gtag snippet in <head> when configured", () => {
    const config = defaultConfig("Paper Notes");
    config.analytics = { ga_measurement_id: MEASUREMENT_ID };
    for (const html of [renderIndexPage({ config, posts: [samplePost()] }), renderPost(config), renderNotFoundPage(config)]) {
      const head = headOf(html);
      expect(head).toContain(GTAG_LOADER);
      expect(head).toContain("window.dataLayer=window.dataLayer||[]");
      expect(head).toContain(GTAG_CONFIG);
      expect(html.split(GTAG_LOADER).length - 1).toBe(1);
    }
  });

  test("the served CSP allows the GA4 loader and beacon origins", () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values.join(" ")];
      })
    );
    expect(directives.get("script-src")).toContain("https://www.googletagmanager.com");
    expect(directives.get("connect-src")).toContain("https://www.google-analytics.com");
    expect(directives.get("connect-src")).toContain("https://region1.google-analytics.com");
  });

  test("[analytics] round-trips through arxiblog.toml load/save", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-analytics-"));
    temporaryRoots.push(root);
    writeFileSync(
      join(root, "arxiblog.toml"),
      `[project]\nname = "Paper Notes"\n\n[analytics]\nga_measurement_id = "${MEASUREMENT_ID}"\n`
    );
    const loaded = loadConfig(root);
    expect(gaMeasurementId(loaded)).toBe(MEASUREMENT_ID);
    saveConfig(root, loaded);
    expect(gaMeasurementId(loadConfig(root))).toBe(MEASUREMENT_ID);

    // Absent section → off, and nothing crashes.
    writeFileSync(join(root, "arxiblog.toml"), `[project]\nname = "Paper Notes"\n`);
    expect(gaMeasurementId(loadConfig(root))).toBe("");
  });
});

describe("social meta", () => {
  test("post pages advertise their own title, description and card", () => {
    const head = headOf(renderPost(defaultConfig("Paper Notes"), "https://example.test/og/sample-post.png"));
    expect(head).toContain('<meta property="og:title" content="샘플 &lt;제목&gt; · Paper Notes">');
    expect(head).toContain('<meta property="og:description" content="부제목 &amp; 설명">');
    expect(head).toContain('<meta property="og:type" content="article">');
    expect(head).toContain('<meta property="og:image" content="https://example.test/og/sample-post.png">');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  test("index page uses the site card when one is supplied", () => {
    const config = defaultConfig("Paper Notes");
    config.project.url = "https://example.test/";
    const head = headOf(renderIndexPage({ config, posts: [samplePost()], ogImage: "https://example.test/og/_site.png" }));
    expect(head).toContain('<meta property="og:title" content="Paper Notes">');
    expect(head).toContain('<meta property="og:image" content="https://example.test/og/_site.png">');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(headOf(renderIndexPage({ config, posts: [] }))).toContain('<meta name="twitter:card" content="summary">');
  });

  test("buildSite writes a site-wide card and wires it into index, 404 and posts", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-og-"));
    temporaryRoots.push(root);
    const store = new Store(join(root, "test.db"));
    const config = defaultConfig("Paper Notes");
    config.project.url = "https://example.test/";
    config.analytics = { ga_measurement_id: MEASUREMENT_ID };
    try {
      const paper = store.upsertPaper({
        arxiv_id: "2601.00001",
        title: "Site card",
        authors: "Test Author",
        abstract: "OG smoke test",
        categories: "cs.SE",
        published: "2026-01-01",
        abs_url: "https://arxiv.org/abs/2601.00001",
        pdf_url: "https://arxiv.org/pdf/2601.00001",
        raw_text: "test",
      });
      store.upsertPost({
        paper_id: paper.id,
        slug: "site-card",
        title: "사이트 카드",
        subtitle: "글 설명",
        tldr: "요약",
        takeaways: [],
        level: "beginner",
        reading_minutes: 1,
        content: "## 본문\n\n내용",
        persona: "friendly",
      });
      await buildSite(store, config, root);
    } finally {
      store.close();
    }

    const out = join(root, "_site");
    const siteCard = join(out, "og", "_site.svg");
    expect(existsSync(siteCard)).toBe(true);
    const svg = readFileSync(siteCard, "utf-8");
    expect(svg).toContain("Paper Notes");
    expect(svg).toContain("example.test");

    const index = headOf(readFileSync(join(out, "index.html"), "utf-8"));
    expect(index).toContain('<meta property="og:image" content="https://example.test/og/_site.svg">');
    expect(index).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(index).toContain(GTAG_LOADER);

    const notFound = headOf(readFileSync(join(out, "404.html"), "utf-8"));
    expect(notFound).toContain('<meta property="og:image" content="https://example.test/og/_site.svg">');

    const post = headOf(readFileSync(join(out, "p", "site-card.html"), "utf-8"));
    expect(post).toContain('<meta property="og:title" content="사이트 카드 · Paper Notes">');
    expect(post).toContain('<meta property="og:description" content="글 설명">');
    expect(post).toContain('<meta property="og:image" content="https://example.test/og/site-card.svg">');
    expect(post).toContain(GTAG_LOADER);
  });
});
