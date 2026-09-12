import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTENT_SECURITY_POLICY,
  documentSecurityHeaders,
  engagementDayOffsetMinutes,
  healthResponse,
  makeChatLimiter,
  MAX_API_BODY_BYTES,
  startServer,
  staticCacheControl,
} from "./server";
import { DB_FILE, defaultConfig, resolveBuildOutputDir, saveConfig } from "./config";
import { CHAT_QUOTA_RESERVATION_TTL_MS, Store } from "./store";

const roots: string[] = [];

function quotaDb(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "arxiblog-quota-"));
  roots.push(root);
  return { root, path: join(root, "quota.db") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable chat quota", () => {
  test("a shared concurrency cap rejects bursts and opens after settlement", () => {
    const { path } = quotaDb();
    const store = new Store(path);
    const limiter = makeChatLimiter(store, () => 1_000);
    const first = limiter.gate("one", 0, 0, 1);
    expect(first.ok).toBe(true);
    const blocked = limiter.gate("two", 0, 0, 1);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("몰리고");
    expect(blocked.retryAfterSeconds).toBe(10);
    first.finish?.(false);
    expect(limiter.gate("two", 0, 0, 1).ok).toBe(true);
    store.close();
  });

  test("an in-flight slot is atomic, failure releases global quota, and success survives restart", () => {
    const { path } = quotaDb();
    let at = Date.UTC(2026, 6, 15, 12);
    const firstStore = new Store(path);
    const firstLimiter = makeChatLimiter(firstStore, () => at);

    const first = firstLimiter.gate("198.51.100.1", 0, 1);
    expect(first.ok).toBe(true);
    expect(firstLimiter.gate("198.51.100.2", 0, 1).ok).toBe(false);

    first.finish?.(false);
    const retry = firstLimiter.gate("198.51.100.2", 0, 1);
    expect(retry.ok).toBe(true);
    retry.finish?.(true);
    retry.finish?.(false); // settlement remains idempotent
    firstStore.close();

    at += 1_000;
    const restartedStore = new Store(path);
    const restartedLimiter = makeChatLimiter(restartedStore, () => at);
    expect(restartedLimiter.gate("198.51.100.3", 0, 1).ok).toBe(false);
    restartedStore.close();
  });

  test("per-IP rolling window is shared after restart and opens at exactly one hour", () => {
    const { path } = quotaDb();
    const startedAt = Date.UTC(2026, 6, 15, 8);
    const firstStore = new Store(path);
    const admitted = firstStore.reserveChatQuota("2001:db8::10", 1, 0, startedAt);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) firstStore.settleChatQuota(admitted.reservationId, true, startedAt + 100);
    firstStore.close();

    const restartedStore = new Store(path);
    expect(restartedStore.reserveChatQuota("2001:DB8::10", 1, 0, startedAt + 3_599_999)).toEqual({
      ok: false,
      reason: "ip",
    });
    expect(restartedStore.reserveChatQuota("2001:db8::10", 1, 0, startedAt + 3_600_000).ok).toBe(true);
    restartedStore.close();
  });

  test("daily quota rolls over on the UTC day boundary", () => {
    const { path } = quotaDb();
    const store = new Store(path);
    const nextDay = Date.UTC(2026, 6, 16);
    const admitted = store.reserveChatQuota("one", 0, 1, nextDay - 1);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) store.settleChatQuota(admitted.reservationId, true, nextDay - 1);

    const beforeBoundary = store.reserveChatQuota("two", 0, 1, nextDay - 1);
    expect(beforeBoundary).toEqual({ ok: false, reason: "global" });
    expect(store.reserveChatQuota("two", 0, 1, nextDay).ok).toBe(true);
    store.close();
  });

  test("an abandoned reservation expires and is cleaned during the next admission", () => {
    const { path } = quotaDb();
    const store = new Store(path);
    const at = Date.UTC(2026, 6, 15, 12);
    expect(store.reserveChatQuota("one", 0, 1, at).ok).toBe(true);
    expect(store.reserveChatQuota("two", 0, 1, at + CHAT_QUOTA_RESERVATION_TTL_MS - 1).ok).toBe(false);
    expect(store.reserveChatQuota("two", 0, 1, at + CHAT_QUOTA_RESERVATION_TTL_MS).ok).toBe(true);

    const inspectionDb = new Database(path);
    const row = inspectionDb.prepare("SELECT status FROM chat_quota_events WHERE reserved_at_ms = ?").get(at) as {
      status: string;
    };
    expect(row.status).toBe("failed");
    inspectionDb.close();
    store.close();
  });

  test("the database stores a stable digest, never the source IP", () => {
    const { path } = quotaDb();
    const sourceIp = "203.0.113.77";
    const store = new Store(path);
    expect(store.reserveChatQuota(sourceIp, 1, 0, 1_000).ok).toBe(true);
    store.close();

    const db = new Database(path, { readonly: true });
    const row = db.prepare("SELECT ip_hash FROM chat_quota_events").get() as { ip_hash: string };
    expect(row.ip_hash).not.toContain(sourceIp);
    expect(row.ip_hash).toMatch(/^[a-f0-9]{64}$/);
    db.close();

    const reopened = new Store(path);
    expect(reopened.reserveChatQuota(sourceIp, 1, 0, 1_001)).toEqual({ ok: false, reason: "ip" });
    reopened.close();
  });

  test("concurrent Bun processes share one atomic global cap", async () => {
    const { path } = quotaDb();
    // Initialize/migrate once so this test isolates admission contention rather
    // than schema-creation contention.
    new Store(path).close();
    const storeModule = join(import.meta.dir, "store.ts");
    const script = `
      import { Store } from ${JSON.stringify(storeModule)};
      const store = new Store(process.argv[1]);
      const result = store.reserveChatQuota(process.argv[2], 0, 3, 1_000_000);
      console.log(JSON.stringify(result));
      store.close();
    `;
    const processes = Array.from({ length: 8 }, (_, index) => Bun.spawn({
      cmd: [process.execPath, "-e", script, path, `worker-${index}`],
      stdout: "pipe",
      stderr: "pipe",
    }));
    const outputs = await Promise.all(processes.map(async (process) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout.trim()) as { ok: boolean };
    }));
    expect(outputs.filter((result) => result.ok)).toHaveLength(3);
  });
});

describe("liveness endpoint response", () => {
  test("GET and HEAD expose only minimal uncached health state", async () => {
    const get = healthResponse("GET");
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("content-type")).toContain("application/json");
    expect(await get.json()).toEqual({ status: "ok" });

    const head = healthResponse("HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");

    const post = healthResponse("POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("cache and security response policy", () => {
  test("only /static/vendor/** is immutable; other assets stay revalidated", () => {
    expect(staticCacheControl("static/vendor/katex/katex.min.js", ".js")).toBe("public, max-age=31536000, immutable");
    expect(staticCacheControl("static/vendor/katex/katex.min.css", ".css")).toBe("public, max-age=31536000, immutable");
    // The rule is the path, not the file name — the vendor directory's contents
    // are being reshuffled and must not need a code change here.
    expect(staticCacheControl("static/vendor/anything-new/x.woff2", ".woff2")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(staticCacheControl("static/app.js", ".js")).toBe("no-cache");
    expect(staticCacheControl("static/style.css", ".css")).toBe("no-cache");
    expect(staticCacheControl("index.html", ".html")).toBe("no-cache");
    expect(staticCacheControl("og/post.png", ".png")).toBe("public, max-age=3600");
    // A path that merely mentions the directory deeper down is not vendor.
    expect(staticCacheControl("posts/static/vendor/fake.js", ".js")).toBe("no-cache");
  });

  test("the policy allows what the built pages actually load and nothing else", () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values.join(" ")];
      })
    );
    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    // GA4 beacons (gtag.js) are the only third-party connect origins.
    expect(directives.get("connect-src")).toBe(
      "'self' https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com"
    );
    expect(directives.get("font-src")).toBe("'self'");
    // Hot-linked arxiv figures.
    expect(directives.get("img-src")).toContain("https:");
    // Build-time inline bootstraps (theme restore, annotation payload, admin
    // script) mean a nonce is unavailable; the only third-party script origin
    // is the GA4 loader — no wildcard, no http.
    expect(directives.get("script-src")).toBe("'self' 'unsafe-inline' https://www.googletagmanager.com");
    expect(directives.get("script-src")).not.toContain("http://");
    expect(directives.get("script-src")).not.toContain("*");
    const headers = documentSecurityHeaders();
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("an unparsed offset falls back to KST, an explicit one wins", () => {
    expect(engagementDayOffsetMinutes(undefined)).toBe(9 * 60);
    expect(engagementDayOffsetMinutes("")).toBe(9 * 60);
    expect(engagementDayOffsetMinutes("not-a-number")).toBe(9 * 60);
    expect(engagementDayOffsetMinutes("99999")).toBe(9 * 60); // out of range
    expect(engagementDayOffsetMinutes("0")).toBe(0);
    expect(engagementDayOffsetMinutes("-300")).toBe(-300);
  });
});

describe("live server responses", () => {
  function bootServer(): { server: ReturnType<typeof startServer>; root: string } {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-server-"));
    roots.push(root);
    const config = defaultConfig("Server lane");
    saveConfig(root, config);

    const store = new Store(join(root, DB_FILE));
    const paper = store.upsertPaper({
      arxiv_id: "2402.00002", title: "Serving Papers", authors: "A", abstract: "a",
      categories: "cs.CL", published: "2024-02-01", abs_url: "", pdf_url: "", raw_text: "body",
    });
    store.upsertPost({
      paper_id: paper.id, slug: "serving-papers", title: "논문 서빙", subtitle: "", tldr: "",
      takeaways: [], level: "beginner", reading_minutes: 1, content: "본문", persona: "friendly",
    });
    store.close();

    const siteDir = resolveBuildOutputDir(root, config.build.output_dir);
    mkdirSync(join(siteDir, "static", "vendor", "katex"), { recursive: true });
    writeFileSync(join(siteDir, "index.html"), "<!DOCTYPE html><title>home</title>");
    writeFileSync(join(siteDir, "404.html"), "<!DOCTYPE html><title>missing</title>");
    writeFileSync(join(siteDir, "static", "app.js"), "// app");
    writeFileSync(join(siteDir, "static", "vendor", "katex", "katex.min.js"), "// katex");

    return { server: startServer(root, 0, "127.0.0.1"), root };
  }

  test("static documents carry CSP and framing protection; vendor assets are immutable", async () => {
    const { server } = bootServer();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const home = await fetch(`${base}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(home.headers.get("x-frame-options")).toBe("DENY");
      expect(home.headers.get("cache-control")).toBe("no-cache");

      const vendor = await fetch(`${base}/static/vendor/katex/katex.min.js`);
      expect(vendor.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const app = await fetch(`${base}/static/app.js`);
      expect(app.headers.get("cache-control")).toBe("no-cache");

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);

      const admin = await fetch(`${base}/admin`);
      expect(admin.status).toBe(200);
      expect(admin.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(admin.headers.get("x-frame-options")).toBe("DENY");
      expect(admin.headers.get("referrer-policy")).toBe("no-referrer");
    } finally {
      server.stop(true);
    }
  });

  test("engagement endpoints validate the body and never echo internal errors", async () => {
    const { server } = bootServer();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const post = (path: string, init: RequestInit) => fetch(base + path, { method: "POST", ...init });
      const json = { "Content-Type": "application/json" };

      // /api/react and /api/subscribe now go through readJsonObject: a wrong
      // content type is 415 and a huge body is 413, never a 500 with details.
      const wrongType = await post("/api/react", { headers: { "Content-Type": "text/plain" }, body: "{}" });
      expect(wrongType.status).toBe(415);
      const oversized = await post("/api/subscribe", {
        headers: json, body: `{"email":"${"a".repeat(MAX_API_BODY_BYTES)}"}`,
      });
      expect(oversized.status).toBe(413);
      const malformed = await post("/api/react", { headers: json, body: "{" });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain("JSON Parse");

      // /api/view stays best-effort: a rejected body is still a quiet zero.
      const badView = await post("/api/view", { headers: { "Content-Type": "text/plain" }, body: "nope" });
      expect(badView.status).toBe(200);
      expect(await badView.json()).toEqual({ views: 0, reactions: 0 });

      // A real view counts once for this client, then de-duplicates.
      const body = JSON.stringify({ slug: "serving-papers" });
      expect(await (await post("/api/view", { headers: json, body })).json()).toEqual({ views: 1, reactions: 0 });
      expect(await (await post("/api/view", { headers: json, body })).json()).toEqual({ views: 1, reactions: 0 });
      expect(await (await post("/api/react", { headers: json, body })).json()).toEqual({ reactions: 1 });
      expect(await (await post("/api/react", { headers: json, body })).json()).toEqual({ reactions: 1 });

      const unknown = await post("/api/react", { headers: json, body: JSON.stringify({ slug: "ghost" }) });
      expect(unknown.status).toBe(404);
      const badEmail = await post("/api/subscribe", { headers: json, body: JSON.stringify({ email: "nope" }) });
      expect(badEmail.status).toBe(400);
      expect(await (await post("/api/subscribe", {
        headers: json, body: JSON.stringify({ email: "Reader@Example.com " }),
      })).json()).toEqual({ ok: true });
    } finally {
      server.stop(true);
    }
  });
});
