import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ENGAGEMENT_REACTION_RETENTION_MS,
  ENGAGEMENT_VIEW_RETENTION_MS,
  engagementDayKey,
  Store,
} from "./store";

const roots: string[] = [];

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
  roots.push(root);
  return new Store(join(root, "engage.db"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engagement stats", () => {
  test("unseen slugs report zeroed stats", () => {
    const store = freshStore();
    expect(store.getStats("never-written")).toEqual({ views: 0, reactions: 0 });
    store.close();
  });

  test("views and reactions accumulate independently per slug", () => {
    const store = freshStore();
    store.incrementView("a");
    store.incrementView("a");
    store.incrementView("b");
    expect(store.getStats("a").views).toBe(2);
    expect(store.getStats("b").views).toBe(1);
    expect(store.getStats("a").reactions).toBe(0);
    store.close();
  });

  test("incrementReaction returns the running total", () => {
    const store = freshStore();
    expect(store.incrementReaction("paper")).toBe(1);
    expect(store.incrementReaction("paper")).toBe(2);
    expect(store.getStats("paper")).toEqual({ views: 0, reactions: 2 });
    store.close();
  });

  test("stats survive a reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
    roots.push(root);
    const path = join(root, "persist.db");
    const first = new Store(path);
    first.incrementView("keep");
    first.incrementReaction("keep");
    first.close();

    const reopened = new Store(path);
    expect(reopened.getStats("keep")).toEqual({ views: 1, reactions: 1 });
    reopened.close();
  });
});

describe("getPost paper hydration", () => {
  // Regression: getPost used `SELECT * FROM posts`, but posts has no arxiv_id
  // column (only paper_id), so post.arxiv_id was undefined and the chat could
  // never reach the source paper. getPost must join papers like listPosts does.
  test("hydrates arxiv_id and paper_title from the joined paper", () => {
    const store = freshStore();
    const paper = store.upsertPaper({
      arxiv_id: "2401.00001",
      title: "A Study of Grounded Retrieval",
      authors: "A. Author",
      abstract: "We ground answers in the source.",
      categories: "cs.CL",
      published: "2024-01-01",
      abs_url: "https://arxiv.org/abs/2401.00001",
      pdf_url: "https://arxiv.org/pdf/2401.00001",
      raw_text: "Full paper body text.",
    });
    store.upsertPost({
      paper_id: paper.id,
      slug: "grounded-retrieval",
      title: "근거 있는 검색 이야기",
      subtitle: "sub",
      tldr: "tldr",
      takeaways: [],
      level: "beginner",
      reading_minutes: 3,
      content: "본문",
      persona: "friendly",
    });

    const post = store.getPost("grounded-retrieval");
    expect(post).not.toBeNull();
    expect(post!.arxiv_id).toBe("2401.00001");
    expect(post!.paper_title).toBe("A Study of Grounded Retrieval");
    // and the paper is now reachable via the hydrated arxiv_id
    expect(store.getPaperByArxivId(post!.arxiv_id || "")?.raw_text).toBe("Full paper body text.");
    store.close();
  });
});

describe("newsletter subscribers", () => {
  test("subscribing is idempotent and case/space-insensitive at the caller boundary", () => {
    const store = freshStore();
    store.addSubscriber("reader@example.com");
    store.addSubscriber("reader@example.com");
    expect(store.countSubscribers()).toBe(1);
    store.addSubscriber("other@example.com");
    expect(store.countSubscribers()).toBe(2);
    store.close();
  });
});

describe("durable engagement de-duplication", () => {
  const KST = 9 * 60;

  test("a repeat view from the same IP is ignored, a different IP still counts", () => {
    const store = freshStore();
    const at = Date.UTC(2026, 8, 5, 3);
    expect(store.recordView("198.51.100.1", "post", at, KST)).toEqual({ counted: true, views: 1, reactions: 0 });
    expect(store.recordView("198.51.100.1", "post", at + 5_000, KST)).toEqual({ counted: false, views: 1, reactions: 0 });
    expect(store.recordView("198.51.100.2", "post", at + 6_000, KST).views).toBe(2);
    // ...and the same reader viewing another post is a separate view.
    expect(store.recordView("198.51.100.1", "other", at + 7_000, KST)).toEqual({ counted: true, views: 1, reactions: 0 });
    store.close();
  });

  test("a reaction is once per IP/post and reports the running total", () => {
    const store = freshStore();
    expect(store.recordReaction("203.0.113.5", "post")).toEqual({ counted: true, reactions: 1 });
    expect(store.recordReaction("203.0.113.5", "post")).toEqual({ counted: false, reactions: 1 });
    expect(store.recordReaction("203.0.113.6", "post")).toEqual({ counted: true, reactions: 2 });
    store.close();
  });

  // The old guard was an in-memory Set, so a LaunchAgent restart reset it and
  // every returning reader inflated the counters again.
  test("de-duplication survives a restart", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
    roots.push(root);
    const path = join(root, "durable.db");
    const at = Date.UTC(2026, 8, 5, 3);

    const first = new Store(path);
    expect(first.recordView("198.51.100.9", "post", at, KST).counted).toBe(true);
    expect(first.recordReaction("198.51.100.9", "post", at).counted).toBe(true);
    first.close();

    const restarted = new Store(path);
    expect(restarted.recordView("198.51.100.9", "post", at + 60_000, KST)).toEqual({
      counted: false, views: 1, reactions: 1,
    });
    expect(restarted.recordReaction("198.51.100.9", "post", at + 60_000)).toEqual({ counted: false, reactions: 1 });
    restarted.close();
  });

  test("the view day boundary follows the requested offset, not UTC", () => {
    const store = freshStore();
    // 2026-09-05 00:30 KST is still 2026-09-04 in UTC.
    const kstMidnightPlus30 = Date.UTC(2026, 8, 4, 15, 30);
    expect(engagementDayKey(kstMidnightPlus30, KST)).toBe("2026-09-05");
    expect(engagementDayKey(kstMidnightPlus30, 0)).toBe("2026-09-04");

    // Same KST day, six hours apart across the UTC midnight → one view only.
    expect(store.recordView("198.51.100.3", "post", Date.UTC(2026, 8, 4, 20), KST).counted).toBe(true);
    expect(store.recordView("198.51.100.3", "post", Date.UTC(2026, 8, 5, 2), KST).counted).toBe(false);
    // Crossing the next KST midnight opens a fresh view.
    expect(store.recordView("198.51.100.3", "post", Date.UTC(2026, 8, 5, 15, 1), KST).counted).toBe(true);
    expect(store.getStats("post").views).toBe(2);
    store.close();
  });

  test("stale rows are pruned by the next admission, with no maintenance job", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
    roots.push(root);
    const path = join(root, "prune.db");
    const at = Date.UTC(2026, 8, 5, 3);
    const store = new Store(path);
    store.recordView("198.51.100.4", "post", at, KST);
    store.recordReaction("198.51.100.4", "post", at);

    const countRows = () => {
      const db = new Database(path, { readonly: true });
      const row = db.prepare("SELECT COUNT(*) AS c FROM engagement_events").get() as { c: number };
      db.close();
      return row.c;
    };
    expect(countRows()).toBe(2);

    // Past the view retention but inside the reaction retention.
    store.recordView("198.51.100.5", "post", at + ENGAGEMENT_VIEW_RETENTION_MS + 1, KST);
    expect(countRows()).toBe(2); // the old view is gone, the new one and the reaction remain

    store.recordView("198.51.100.6", "post", at + ENGAGEMENT_REACTION_RETENTION_MS + 1, KST);
    expect(countRows()).toBe(1); // only the newest view survives
    store.close();
  });

  test("the table stores a digest, never the source address", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
    roots.push(root);
    const path = join(root, "hash.db");
    const sourceIp = "203.0.113.77";
    const store = new Store(path);
    store.recordView(sourceIp, "post", Date.UTC(2026, 8, 5, 3), KST);
    store.recordReaction(sourceIp, "post", Date.UTC(2026, 8, 5, 3));
    store.close();

    const db = new Database(path, { readonly: true });
    const rows = db.prepare("SELECT kind, ip_hash, slug, day_key FROM engagement_events").all() as Array<{
      kind: string; ip_hash: string; slug: string; day_key: string;
    }>;
    db.close();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.ip_hash).not.toContain(sourceIp);
      expect(row.ip_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(rows.find((r) => r.kind === "view")!.day_key).toBe("2026-09-05");
    // A reaction has no day bucket, so it never rolls over.
    expect(rows.find((r) => r.kind === "react")!.day_key).toBe("");
  });
});
