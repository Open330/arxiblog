import { test, expect, describe } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fetchArxivFullText, fetchArxivMeta, MAX_PDF_BYTES, parseArxivId } from "./ingest/arxiv";
import { parseLlmJson, slugify, estimateReadingMinutes, stripJsonFences, repairMathDelimiters } from "./utils";
import { buildSite, renderPostBody, generateToc, injectHeadingIds } from "./build/renderer";
import { renderNotFoundPage } from "./build/templates";
import { CONFIG_FILE, defaultConfig, hasLlmKey, loadConfig, resolveBuildOutputDir, saveConfig } from "./config";
import { handleSettings, jsonError, makeChatLimiter, MAX_API_BODY_BYTES, readJsonObject } from "./server";
import { Store, type Annotation, type Paper } from "./store";

const ann = (term: string, explanation: string, kind = "jargon"): Annotation =>
  ({ id: 0, post_id: 0, term, kind, explanation } as Annotation);

describe("parseArxivId", () => {
  test("plain id, with version, abs/pdf URLs, prefix, old-style", () => {
    expect(parseArxivId("2605.31264")).toBe("2605.31264");
    expect(parseArxivId("2106.09685v2")).toBe("2106.09685v2");
    expect(parseArxivId("https://arxiv.org/abs/1706.03762")).toBe("1706.03762");
    expect(parseArxivId("https://arxiv.org/pdf/2010.11929")).toBe("2010.11929");
    expect(parseArxivId("arXiv:1810.04805")).toBe("1810.04805");
    expect(parseArxivId("math.GT/0309136")).toBe("math.GT/0309136");
    expect(parseArxivId("arxiv.org/abs/1706.03762")).toBe("1706.03762");
  });
  test("rejects malformed ids and spoofed/traversal URLs before network access", () => {
    for (const source of [
      "garbage",
      "https://notarxiv.org/abs/1706.03762",
      "https://evil.test/?u=arxiv.org/abs/1706.03762",
      "https://arxiv.org/abs/../../etc/passwd",
    ]) {
      expect(() => parseArxivId(source)).toThrow("올바른 arXiv ID");
    }
  });

  test("versioned metadata and PDF requests preserve the requested revision", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(`<?xml version="1.0"?><feed><entry>
        <id>https://arxiv.org/abs/2106.09685v2</id>
        <title>Version two</title><summary>Revised abstract</summary>
        <published>2021-06-18T00:00:00Z</published>
        <author><name>Author</name></author><category term="cs.CL"/>
      </entry></feed>`);
    }) as typeof fetch;
    try {
      const meta = await fetchArxivMeta("2106.09685v2");
      expect(requestedUrl).toContain("id_list=2106.09685v2");
      expect(meta.arxivId).toBe("2106.09685v2");
      expect(meta.pdfUrl).toBe("https://arxiv.org/pdf/2106.09685v2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("parseLlmJson", () => {
  test("plain JSON", () => {
    expect(parseLlmJson<{ a: number }>('{"a":1}').a).toBe(1);
  });
  test("fenced JSON", () => {
    expect(parseLlmJson<{ a: number }>('```json\n{"a":2}\n```').a).toBe(2);
  });
  test("trailing prose with brace-y emoji does not fool the scanner", () => {
    const r = parseLlmJson<{ a: number; note: string }>('```json\n{"a":3,"note":"end :}"}\n```\n도움이 됐길 :}');
    expect(r.a).toBe(3);
  });
  test("braces inside string values are balanced correctly", () => {
    expect(parseLlmJson<{ s: string }>('prefix {"s":"a{b}c"} suffix').s).toBe("a{b}c");
  });
  test("stripJsonFences removes md fences", () => {
    expect(stripJsonFences("```json\n{}\n```")).toBe("{}");
  });
  test("repairMathDelimiters balances a $$…$ block, leaves good ones alone", () => {
    expect(repairMathDelimiters("$$x=1$\n\nnext")).toBe("$$x=1$$\n\nnext");
    expect(repairMathDelimiters("$$x=1$$\n\nok")).toBe("$$x=1$$\n\nok");
    expect(repairMathDelimiters("inline $y$ only")).toBe("inline $y$ only");
  });
  test("repairs unescaped LaTeX backslashes in string values", () => {
    // gemini emits `\frac`, `\right`, `\pi` etc. inside JSON strings unescaped.
    const r = parseLlmJson<{ eq: string; ok: string }>('{"eq":"G=\\frac{a}{q}, \\right, \\pi","ok":"a real \\"quote\\""}');
    expect(r.eq).toBe("G=\\frac{a}{q}, \\right, \\pi");
    expect(r.ok).toContain('"quote"');
  });
  test("valid escapes and control newlines survive the repair", () => {
    // \\ stays a literal backslash; \n before a non-letter stays a newline.
    const r = parseLlmJson<{ path: string; nl: string }>('{"path":"a\\\\b\\\\c","nl":"para1\\n\\n# para2"}');
    expect(r.path).toBe("a\\b\\c");
    expect(r.nl).toBe("para1\n\n# para2");
  });
});

describe("slugify / reading time", () => {
  test("slugify keeps Korean, drops punctuation", () => {
    expect(slugify("Attention Is All You Need!")).toBe("attention-is-all-you-need");
    expect(slugify("어텐션 하나로 충분하다")).toBe("어텐션-하나로-충분하다");
  });
  test("reading time does not double-count Korean", () => {
    const korean = "한국어 ".repeat(500); // 1500 hangul chars
    expect(estimateReadingMinutes(korean)).toBe(3); // ~1500/500
    expect(estimateReadingMinutes("")).toBe(1); // floor at 1
  });
});

describe("renderPostBody", () => {
  test("math with < > is escaped (KaTeX-safe), currency preserved", async () => {
    const h = await renderPostBody("인라인 $f(x)<g(x)$ 그리고 가격 $5, $10.", []);
    expect(h).toContain("$f(x)&lt;g(x)$");
    expect(h).toContain("$5, $10");
  });
  test("a $$…$ block closed by a lone $ does not swallow the next heading", async () => {
    const md = "앞 문단.\n\n$$u_m := \\frac{T_m}{2m+1}$\n\n## 어떻게 동작하나\n\n본문 계속.";
    const h = await renderPostBody(md, []);
    expect(h).toContain("<h2"); // heading survived instead of being eaten into math
    expect(h).toContain("어떻게 동작하나");
    expect(h).toContain("$$u_m := \\frac{T_m}{2m+1}$$"); // delimiter repaired to a real block
  });
  test("annotation fuzzy match + plain fallback for unmatched", async () => {
    const h = await renderPostBody("핵심은 [[어텐션 메커니즘]]과 [[모르는용어]] 입니다.", [
      ann("어텐션", "집중 가중치 기법"),
    ]);
    expect(h).toContain("annot-pop"); // matched via substring fallback
    expect(h).not.toContain("annot-missing"); // unmatched renders as plain text
    expect(h).toContain("모르는용어");
  });
  test("annotation explanation is HTML-escaped (no XSS via popover)", async () => {
    const h = await renderPostBody("위험 [[term]] 끝.", [ann("term", '</span><img src=x onerror=alert(1)>')]);
    expect(h).not.toContain("<img src=x onerror");
    expect(h).toContain("&lt;img");
  });
  test("mermaid fence becomes <pre class=mermaid> with escaped arrows", async () => {
    const h = await renderPostBody("```mermaid\nflowchart TD\n  A --> B\n```", []);
    expect(h).toContain('<pre class="mermaid">');
    expect(h).toContain("--&gt;");
  });
  test("literal placeholder-like prose cannot duplicate an annotation", async () => {
    const h = await renderPostBody("[[term]] 그리고 %%ANNOT0%%", [ann("term", "설명")]);
    expect((h.match(/class="annot"/g) || []).length).toBe(1);
    expect(h).toContain("%%ANNOT0%%");
  });
});

describe("toc + heading ids", () => {
  test("generateToc dedupes ids; injectHeadingIds assigns them positionally", async () => {
    const md = "## 들어가며\n\n본문\n\n## 결과\n\n## 결과\n\n중복";
    const toc = generateToc(md);
    expect(toc.map((t) => t.id)).toEqual(["들어가며", "결과", "결과-1"]);
    const html = injectHeadingIds(await renderPostBody(md, []), toc);
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["들어가며", "결과", "결과-1"]);
  });
  test("'##' inside a code fence is NOT a TOC heading (no id desync)", async () => {
    const md = "## 들어가며\n\n```bash\n## this is a comment\n```\n\n## 결과\n\n끝";
    const toc = generateToc(md);
    expect(toc.map((t) => t.text)).toEqual(["들어가며", "결과"]);
    const html = injectHeadingIds(await renderPostBody(md, []), toc);
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["들어가며", "결과"]); // real headings keep correct ids
  });
  test("headings inside tilde and long-backtick fences are ignored", () => {
    const md = "## 시작\n\n~~~text\n## 가짜\n~~~\n\n````md\n## 또 가짜\n````\n\n## 끝";
    expect(generateToc(md).map((item) => item.text)).toEqual(["시작", "끝"]);
  });
});

describe("static 404 paths", () => {
  test("assets stay rooted at the configured project URL from deeply nested misses", () => {
    const config = defaultConfig("Docs");
    config.project.url = "https://example.test/arxiblog";
    const html = renderNotFoundPage(config);
    expect(html).toContain('href="/arxiblog/static/style.css"');
    expect(html).toContain('src="/arxiblog/static/app.js"');
    expect(html).toContain('href="/arxiblog/">← 홈으로 돌아가기</a>');
  });
});

describe("hasLlmKey (provider-aware)", () => {
  const base = { model: "m", endpoint: "" };
  test("gemini: pool or paid counts even with empty api_key", () => {
    expect(hasLlmKey({ provider: "gemini", api_key: "", api_keys: ["k1"], ...base })).toBe(true);
    expect(hasLlmKey({ provider: "gemini", api_key: "", api_key_paid: "p", ...base })).toBe(true);
    expect(hasLlmKey({ provider: "gemini", api_key: "", ...base })).toBe(false);
  });
  test("openai/anthropic require api_key; gemini pool does not satisfy them", () => {
    expect(hasLlmKey({ provider: "openai", api_key: "", api_keys: ["k1"], ...base })).toBe(false);
    expect(hasLlmKey({ provider: "openai", api_key: "sk-x", ...base })).toBe(true);
    expect(hasLlmKey({ provider: "anthropic", api_key: "", ...base })).toBe(false);
  });
  test("whitespace-only keys do not trigger paid API calls", () => {
    expect(hasLlmKey({ provider: "gemini", api_key: "  ", api_keys: ["", " \t"], api_key_paid: " ", ...base })).toBe(false);
    expect(hasLlmKey({ provider: "openai", api_key: " \n", ...base })).toBe(false);
  });
});

describe("configuration and build safety", () => {
  test("output stays inside the project and cannot traverse symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-root-"));
    const outside = mkdtempSync(join(tmpdir(), "arxiblog-outside-"));
    try {
      expect(resolveBuildOutputDir(root, "_site")).toBe(join(realpathSync(root), "_site"));
      expect(() => resolveBuildOutputDir(root, ".")).toThrow();
      expect(() => resolveBuildOutputDir(root, "../outside")).toThrow();
      expect(() => resolveBuildOutputDir(root, outside)).toThrow();
      if (process.platform !== "win32") {
        symlinkSync(outside, join(root, "linked"), "dir");
        expect(() => resolveBuildOutputDir(root, "linked/site")).toThrow("심볼릭 링크");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("saveConfig is immediately readable, private, and leaves no temp file", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-config-"));
    try {
      const config = defaultConfig("Atomic config");
      config.llm.api_key = "test-secret";
      saveConfig(root, config);
      expect(loadConfig(root).llm.api_key).toBe("test-secret");
      if (process.platform !== "win32") {
        expect(statSync(join(root, CONFIG_FILE)).mode & 0o777).toBe(0o600);
      }
      expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("saveConfig preserves a fixed [server].admin_token across a settings save", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-server-token-"));
    try {
      const config = defaultConfig("Server token");
      config.server = { admin_token: "0123456789abcdef0123456789abcdef" };
      saveConfig(root, config);
      // A later save (e.g. editing settings) must not drop the section.
      const reloaded = loadConfig(root);
      reloaded.default_level = "advanced";
      saveConfig(root, reloaded);
      expect(loadConfig(root).server?.admin_token).toBe("0123456789abcdef0123456789abcdef");
      expect(loadConfig(root).default_level).toBe("advanced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConfig fills missing legacy sections and fields", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-legacy-"));
    try {
      writeFileSync(join(root, CONFIG_FILE), '[project]\nname = "Legacy"\n\n[llm]\nprovider = "gemini"\nmodel = "gemini-3.1-flash-lite-preview"\napi_key = ""\n');
      const config = loadConfig(root);
      expect(config.project.name).toBe("Legacy");
      expect(config.build.output_dir).toBe("_site");
      expect(config.llm.endpoint).toBe("");
      expect(config.chat?.per_ip_per_hour).toBeGreaterThan(0);
      expect(config.chat?.max_in_flight).toBeGreaterThan(0);
      expect(config.llm.model).toBe("gemini-3.1-flash-lite");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid chat settings fall back to safe bounded defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-chat-config-"));
    try {
      writeFileSync(join(root, CONFIG_FILE), `[project]\nname = "Chat config"\n\n[chat]\nper_ip_per_hour = "unlimited"\nglobal_per_day = -1\nmax_in_flight = 99999\ntrust_proxy = "yes"\n`);
      const config = loadConfig(root);
      expect(config.chat?.per_ip_per_hour).toBe(30);
      expect(config.chat?.global_per_day).toBe(800);
      expect(config.chat?.max_in_flight).toBe(256);
      expect(config.chat?.trust_proxy).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed build preserves the previous live site and removes staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-build-"));
    const output = join(root, "_site");
    mkdirSync(output);
    writeFileSync(join(output, "index.html"), "last-known-good");
    const config = defaultConfig("Build safety");
    const brokenStore = { listPosts: () => { throw new Error("simulated render failure"); } } as unknown as Store;
    try {
      await expect(buildSite(brokenStore, config, root)).rejects.toThrow("simulated render failure");
      expect(readFileSync(join(output, "index.html"), "utf-8")).toBe("last-known-good");
      expect(readdirSync(root).some((name) => name.startsWith("._site.tmp-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a successful rebuild installs a complete site and removes stale output", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-build-success-"));
    const store = new Store(join(root, "test.db"));
    const config = defaultConfig("Build smoke");
    try {
      expect(await buildSite(store, config, root)).toBe(0);
      expect(existsSync(join(root, "_site", "index.html"))).toBe(true);
      expect(existsSync(join(root, "_site", "404.html"))).toBe(true);
      writeFileSync(join(root, "_site", "stale.txt"), "remove me");
      expect(await buildSite(store, config, root)).toBe(0);
      expect(existsSync(join(root, "_site", "stale.txt"))).toBe(false);
      expect(readdirSync(root).some((name) => name.startsWith("._site.old-"))).toBe(false);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("HTTP input and chat quota boundaries", () => {
  test("readJsonObject reports malformed, unsupported, and oversized bodies", async () => {
    await expect(readJsonObject(new Request("http://test", { method: "POST", body: "{" }))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonObject(new Request("http://test", {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
    }))).rejects.toMatchObject({ status: 415 });
    await expect(readJsonObject(new Request("http://test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: `{"x":"${"a".repeat(MAX_API_BODY_BYTES)}"}`,
    }))).rejects.toMatchObject({ status: 413 });
  });

  test("global quota reserves in-flight calls and releases failed calls", () => {
    const limiter = makeChatLimiter(() => 1_000);
    const first = limiter.gate("one", 0, 1);
    expect(first.ok).toBe(true);
    expect(limiter.gate("two", 0, 1).ok).toBe(false);
    first.finish?.(false);
    const retry = limiter.gate("two", 0, 1);
    expect(retry.ok).toBe(true);
    retry.finish?.(true);
    retry.finish?.(false); // settlement is idempotent
    expect(limiter.gate("three", 0, 1).ok).toBe(false);
  });

  test("unexpected server errors never expose their message", async () => {
    const secret = 'TOML parse failed near api_key = "private-secret"';
    const reported: string[] = [];
    const response = jsonError(new SyntaxError(secret), (name) => reported.push(name));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private-secret");
    expect(reported).toEqual(["SyntaxError"]);
  });

  test("an explicit admin action clears every stored LLM credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-clear-keys-"));
    try {
      const config = defaultConfig("Clear keys");
      config.llm.api_key = "primary-secret";
      config.llm.api_keys = ["pool-secret"];
      config.llm.api_key_paid = "paid-secret";
      saveConfig(root, config);
      const response = await handleSettings(new Request("http://test/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_api_keys: true }),
      }), root);
      expect(response.status).toBe(200);
      const saved = loadConfig(root);
      expect(saved.llm.api_key).toBe("");
      expect(saved.llm.api_keys).toEqual([]);
      expect(saved.llm.api_key_paid).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changing provider never carries the previous provider's credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-provider-key-"));
    try {
      const config = defaultConfig("Provider key isolation");
      config.llm.provider = "openai";
      config.llm.model = "gpt-5.4-nano";
      config.llm.api_key = "openai-secret";
      config.llm.api_keys = ["old-gemini-pool"];
      config.llm.api_key_paid = "old-gemini-paid";
      config.llm.endpoint = "https://old-endpoint.example";
      saveConfig(root, config);
      const response = await handleSettings(new Request("http://test/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", model: "gpt-5.4-nano", endpoint: "https://stale-endpoint.example" }),
      }), root);
      expect(response.status).toBe(200);
      const saved = loadConfig(root);
      expect(saved.llm.provider).toBe("anthropic");
      expect(saved.llm.model).toBe("claude-sonnet-4-6");
      expect(saved.llm.api_key).toBe("");
      expect(saved.llm.api_keys).toEqual([]);
      expect(saved.llm.api_key_paid).toBe("");
      expect(saved.llm.endpoint).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ingest resource limits", () => {
  test("oversized PDF is rejected from headers without buffering or parsing", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("not buffered", { status: 200, headers: { "Content-Length": String(MAX_PDF_BYTES + 1) } });
    }) as unknown as typeof fetch;
    try {
      expect(await fetchArxivFullText("https://arxiv.org/pdf/1706.03762")).toBe("");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Store transaction integrity", () => {
  const paperData = (arxivId: string): Omit<Paper, "id" | "fetched_at"> => ({
    arxiv_id: arxivId, title: arxivId, authors: "", abstract: "", categories: "cs.AI",
    published: "2026-01-01", abs_url: "", pdf_url: "", raw_text: "",
  });
  const postData = (paperId: number, slug: string) => ({
    paper_id: paperId, slug, title: slug, subtitle: "", tldr: "", takeaways: [],
    level: "beginner", reading_minutes: 1, content: "body", persona: "friendly",
  });

  test("database and SQLite sidecars are private", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-private-db-"));
    const path = join(root, "test.db");
    const store = new Store(path);
    try {
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        for (const suffix of ["-wal", "-shm"]) {
          const sidecar = path + suffix;
          if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a slug collision cannot move another paper's post or erase the old one", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-store-"));
    const store = new Store(join(root, "test.db"));
    try {
      const one = store.upsertPaper(paperData("2601.00001"));
      const two = store.upsertPaper(paperData("2601.00002"));
      store.upsertPost(postData(one.id, "one"));
      store.upsertPost(postData(two.id, "taken"));
      expect(() => store.upsertPost(postData(one.id, "taken"))).toThrow("다른 논문");
      expect(store.getPost("one")?.paper_id).toBe(one.id);
      expect(store.getPost("taken")?.paper_id).toBe(two.id);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed annotation replacement rolls back the preceding delete", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-annotations-"));
    const store = new Store(join(root, "test.db"));
    try {
      const paper = store.upsertPaper(paperData("2601.00003"));
      const post = store.upsertPost(postData(paper.id, "annotations"));
      store.replaceAnnotations(post.id, [{ term: "old", kind: "jargon", explanation: "kept" }]);
      expect(() => store.replaceAnnotations(post.id, [
        { term: "bad", kind: "jargon", explanation: null as unknown as string },
      ])).toThrow();
      expect(store.getAnnotations(post.id).map((item) => item.term)).toEqual(["old"]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
