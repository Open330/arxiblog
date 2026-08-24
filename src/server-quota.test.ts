import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthResponse, makeChatLimiter } from "./server";
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
