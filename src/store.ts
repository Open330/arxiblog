import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A crashed worker must not hold a paid-chat slot forever. This is deliberately
 * longer than the HTTP/provider deadline, while still making crash recovery
 * automatic without a separate cleanup job.
 */
export const CHAT_QUOTA_RESERVATION_TTL_MS = 10 * 60 * 1_000;

export type ChatQuotaReservation =
  | { ok: true; reservationId?: string }
  | { ok: false; reason: "global" | "ip" | "concurrency" };

export interface Paper {
  id: number;
  arxiv_id: string;
  title: string;
  authors: string; // comma-separated
  abstract: string;
  categories: string; // comma-separated arxiv categories
  published: string;
  abs_url: string;
  pdf_url: string;
  raw_text: string;
  fetched_at: string;
}

export interface Post {
  id: number;
  paper_id: number;
  slug: string;
  title: string;
  subtitle: string;
  tldr: string;
  takeaways: string; // JSON array of strings
  level: string; // beginner | intermediate
  reading_minutes: number;
  content: string; // markdown body (with [[term]] annotation markers)
  persona: string;
  created_at: string;
  // structured review (JSON arrays / text)
  contributions: string; // JSON array
  strengths: string; // JSON array
  limitations: string; // JSON array
  prerequisites: string; // JSON array
  who_should_read: string; // text
  suggested_questions: string; // JSON array
  key_references: string; // JSON array of {title, why, arxiv_id?}
  figures: string; // JSON array of {imageUrl, caption, explanation}
  translation_en: string; // JSON of the English TranslatedPost, or ""
  reviewed_at: string; // ISO timestamp when the fact-check pass ran, or ""
  verify_notes: string; // JSON of the VerifyReport (checked count + adjustments), or ""
  // joined
  paper_title?: string;
  arxiv_id?: string;
  categories?: string;
}

export interface Annotation {
  id: number;
  post_id: number;
  term: string;
  kind: string; // jargon | concept | context | math
  explanation: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arxiv_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  authors TEXT DEFAULT '',
  abstract TEXT DEFAULT '',
  categories TEXT DEFAULT '',
  published TEXT DEFAULT '',
  abs_url TEXT DEFAULT '',
  pdf_url TEXT DEFAULT '',
  raw_text TEXT DEFAULT '',
  fetched_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  tldr TEXT DEFAULT '',
  takeaways TEXT DEFAULT '[]',
  level TEXT NOT NULL DEFAULT 'beginner',
  reading_minutes INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL DEFAULT '',
  persona TEXT DEFAULT '',
  contributions TEXT DEFAULT '[]',
  strengths TEXT DEFAULT '[]',
  limitations TEXT DEFAULT '[]',
  prerequisites TEXT DEFAULT '[]',
  who_should_read TEXT DEFAULT '',
  suggested_questions TEXT DEFAULT '[]',
  key_references TEXT DEFAULT '[]',
  figures TEXT DEFAULT '[]',
  translation_en TEXT DEFAULT '',
  reviewed_at TEXT DEFAULT '',
  verify_notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'jargon',
  explanation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER REFERENCES papers(id) ON DELETE SET NULL,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_quota_events (
  reservation_id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed')),
  settled_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_posts_paper ON posts(paper_id);
CREATE INDEX IF NOT EXISTS idx_annotations_post ON annotations(post_id);
CREATE INDEX IF NOT EXISTS idx_chat_quota_ip_time ON chat_quota_events(ip_hash, reserved_at_ms);
CREATE INDEX IF NOT EXISTS idx_chat_quota_status_time ON chat_quota_events(status, reserved_at_ms);
CREATE TABLE IF NOT EXISTS post_stats (
  slug TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0,
  reactions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export class Store {
  private db: Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
    // Migrate existing DBs: add structured-review columns that are missing.
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>).map((r) => r.name)
    );
    const newCols: Record<string, string> = {
      contributions: "TEXT DEFAULT '[]'",
      strengths: "TEXT DEFAULT '[]'",
      limitations: "TEXT DEFAULT '[]'",
      prerequisites: "TEXT DEFAULT '[]'",
      who_should_read: "TEXT DEFAULT ''",
      suggested_questions: "TEXT DEFAULT '[]'",
      key_references: "TEXT DEFAULT '[]'",
      figures: "TEXT DEFAULT '[]'",
      translation_en: "TEXT DEFAULT ''",
      reviewed_at: "TEXT DEFAULT ''",
      verify_notes: "TEXT DEFAULT ''",
    };
    for (const [name, type] of Object.entries(newCols)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
    }
    this.protectDatabaseFiles();
  }

  /** The database contains paper text, usage data, and pseudonymous quota keys. */
  private protectDatabaseFiles(): void {
    if (this.dbPath === ":memory:") return;
    for (const path of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (!existsSync(path)) continue;
      try {
        chmodSync(path, 0o600);
      } catch {
        // Read/write failures will surface through SQLite itself. Permission
        // hardening is best-effort on filesystems that do not support chmod.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Papers ---

  upsertPaper(p: Omit<Paper, "id" | "fetched_at">): Paper {
    const existing = this.db.prepare("SELECT * FROM papers WHERE arxiv_id = ?").get(p.arxiv_id) as Paper | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE papers SET title=?, authors=?, abstract=?, categories=?, published=?, abs_url=?, pdf_url=?, raw_text=?, fetched_at=datetime('now') WHERE id=?`
        )
        .run(p.title, p.authors, p.abstract, p.categories, p.published, p.abs_url, p.pdf_url, p.raw_text, existing.id);
      return this.db.prepare("SELECT * FROM papers WHERE id=?").get(existing.id) as Paper;
    }
    this.db
      .prepare(
        `INSERT INTO papers (arxiv_id, title, authors, abstract, categories, published, abs_url, pdf_url, raw_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.arxiv_id, p.title, p.authors, p.abstract, p.categories, p.published, p.abs_url, p.pdf_url, p.raw_text);
    return this.db.prepare("SELECT * FROM papers WHERE arxiv_id=?").get(p.arxiv_id) as Paper;
  }

  getPaperByArxivId(arxivId: string): Paper | null {
    return (this.db.prepare("SELECT * FROM papers WHERE arxiv_id=?").get(arxivId) as Paper) ?? null;
  }

  // --- Posts ---

  upsertPost(p: {
    paper_id: number;
    slug: string;
    title: string;
    subtitle: string;
    tldr: string;
    takeaways: string[];
    level: string;
    reading_minutes: number;
    content: string;
    persona: string;
    contributions?: string[];
    strengths?: string[];
    limitations?: string[];
    prerequisites?: string[];
    who_should_read?: string;
    suggested_questions?: string[];
    key_references?: Array<{ title: string; why: string; arxiv_id?: string }>;
    figures?: Array<{ imageUrl: string; caption: string; explanation: string }>;
    translation_en?: string;
    reviewed_at?: string;
    verify_notes?: string;
  }): Post {
    const save = this.db.transaction((input: typeof p): Post => {
      // A slug collision must never move another paper's post. This can occur
      // with imported/legacy data even though generated slugs normally include
      // the arXiv id.
      const owner = this.db.prepare("SELECT paper_id FROM posts WHERE slug=?").get(input.slug) as
        | { paper_id: number }
        | undefined;
      if (owner && owner.paper_id !== input.paper_id) {
        throw new Error(`이미 다른 논문에서 사용 중인 slug입니다: ${input.slug}`);
      }

      // One post per paper: drop any stale post for this paper whose slug differs
      // (e.g. re-running `add` produced a slightly different title → new slug).
      // Keep this deletion in the same transaction as the replacement so a
      // failed insert cannot erase the last good post and its annotations.
      this.db.prepare("DELETE FROM posts WHERE paper_id = ? AND slug <> ?").run(input.paper_id, input.slug);
      this.db.prepare(
        `INSERT INTO posts (paper_id, slug, title, subtitle, tldr, takeaways, level, reading_minutes, content, persona,
            contributions, strengths, limitations, prerequisites, who_should_read, suggested_questions, key_references,
            figures, translation_en, reviewed_at, verify_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           paper_id=excluded.paper_id, title=excluded.title, subtitle=excluded.subtitle,
           tldr=excluded.tldr, takeaways=excluded.takeaways, level=excluded.level,
           reading_minutes=excluded.reading_minutes, content=excluded.content, persona=excluded.persona,
           contributions=excluded.contributions, strengths=excluded.strengths, limitations=excluded.limitations,
           prerequisites=excluded.prerequisites, who_should_read=excluded.who_should_read,
           suggested_questions=excluded.suggested_questions, key_references=excluded.key_references,
           figures=excluded.figures, translation_en=excluded.translation_en, reviewed_at=excluded.reviewed_at,
           verify_notes=excluded.verify_notes`
      ).run(
        input.paper_id,
        input.slug,
        input.title,
        input.subtitle,
        input.tldr,
        JSON.stringify(input.takeaways),
        input.level,
        input.reading_minutes,
        input.content,
        input.persona,
        JSON.stringify(input.contributions ?? []),
        JSON.stringify(input.strengths ?? []),
        JSON.stringify(input.limitations ?? []),
        JSON.stringify(input.prerequisites ?? []),
        input.who_should_read ?? "",
        JSON.stringify(input.suggested_questions ?? []),
        JSON.stringify(input.key_references ?? []),
        JSON.stringify(input.figures ?? []),
        input.translation_en ?? "",
        input.reviewed_at ?? "",
        input.verify_notes ?? ""
      );
      return this.db.prepare("SELECT * FROM posts WHERE slug=?").get(input.slug) as Post;
    });
    return save(p);
  }

  getPost(slug: string): Post | null {
    // Join papers so arxiv_id / paper_title / categories are hydrated — the
    // chat grounds on the source paper via post.arxiv_id, and posts has only
    // paper_id, so a bare SELECT * would leave arxiv_id undefined.
    return (this.db
      .prepare(
        `SELECT po.*, pa.title AS paper_title, pa.arxiv_id AS arxiv_id, pa.categories AS categories
         FROM posts po JOIN papers pa ON pa.id = po.paper_id WHERE po.slug=?`
      )
      .get(slug) as Post) ?? null;
  }

  getPostByPaper(paperId: number): Post | null {
    return (this.db
      .prepare(
        `SELECT po.*, pa.title AS paper_title, pa.arxiv_id AS arxiv_id, pa.categories AS categories
         FROM posts po JOIN papers pa ON pa.id = po.paper_id
         WHERE po.paper_id=? ORDER BY po.id DESC LIMIT 1`
      )
      .get(paperId) as Post) ?? null;
  }

  listPosts(): Post[] {
    return this.db
      .prepare(
        `SELECT po.*, pa.title AS paper_title, pa.arxiv_id AS arxiv_id, pa.categories AS categories
         FROM posts po JOIN papers pa ON pa.id = po.paper_id
         ORDER BY po.created_at DESC, po.id DESC`
      )
      .all() as Post[];
  }

  countPosts(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM posts").get() as { c: number }).c;
  }

  deletePost(slug: string): void {
    this.db.prepare("DELETE FROM posts WHERE slug=?").run(slug);
  }

  // --- Annotations ---

  replaceAnnotations(postId: number, annotations: Array<{ term: string; kind: string; explanation: string }>): void {
    const insert = this.db.prepare("INSERT INTO annotations (post_id, term, kind, explanation) VALUES (?, ?, ?, ?)");
    const tx = this.db.transaction((rows: typeof annotations) => {
      // Delete and replacement are one unit: a malformed row or disk error must
      // not discard the previously valid glossary.
      this.db.prepare("DELETE FROM annotations WHERE post_id=?").run(postId);
      for (const a of rows) insert.run(postId, a.term, a.kind || "jargon", a.explanation);
    });
    tx(annotations);
  }

  getAnnotations(postId: number): Annotation[] {
    return this.db.prepare("SELECT * FROM annotations WHERE post_id=? ORDER BY id").all(postId) as Annotation[];
  }

  // --- Usage ---

  addUsageLog(paperId: number | null, calls: number, prompt: number, completion: number, total: number, cost: number): void {
    this.db
      .prepare(
        "INSERT INTO usage_logs (paper_id, llm_calls, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(paperId, calls, prompt, completion, total, cost);
  }

  getUsageSummary(): { totalCalls: number; totalTokens: number; totalCost: number } {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(llm_calls),0) AS totalCalls, COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(estimated_cost_usd),0) AS totalCost FROM usage_logs"
      )
      .get() as { totalCalls: number; totalTokens: number; totalCost: number };
    return row;
  }

  // --- Engagement (views / reactions) ---

  incrementView(slug: string): void {
    this.db
      .prepare(
        "INSERT INTO post_stats (slug, views, reactions) VALUES (?, 1, 0) ON CONFLICT(slug) DO UPDATE SET views = views + 1"
      )
      .run(slug);
  }

  incrementReaction(slug: string): number {
    this.db
      .prepare(
        "INSERT INTO post_stats (slug, views, reactions) VALUES (?, 0, 1) ON CONFLICT(slug) DO UPDATE SET reactions = reactions + 1"
      )
      .run(slug);
    return (this.db.prepare("SELECT reactions FROM post_stats WHERE slug = ?").get(slug) as { reactions: number }).reactions;
  }

  getStats(slug: string): { views: number; reactions: number } {
    const row = this.db.prepare("SELECT views, reactions FROM post_stats WHERE slug = ?").get(slug) as
      | { views: number; reactions: number }
      | undefined;
    return row ?? { views: 0, reactions: 0 };
  }

  // --- Newsletter subscribers ---

  addSubscriber(email: string): void {
    this.db.prepare("INSERT OR IGNORE INTO subscribers (email) VALUES (?)").run(email);
  }

  countSubscribers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM subscribers").get() as { c: number }).c;
  }

  // --- Public chat quota ---

  /**
   * Atomically check per-IP, daily, and in-flight limits and reserve one slot.
   *
   * Per-IP quota intentionally counts every admitted attempt for one rolling
   * hour (including an upstream failure), preserving the previous abuse guard.
   * Global quota counts only pending/successful calls; settling a failure
   * releases that paid-call slot immediately.
   */
  reserveChatQuota(
    ip: string,
    perIpPerHour: number,
    globalPerDay: number,
    at = Date.now(),
    maxInFlight = 0
  ): ChatQuotaReservation {
    const perIpLimit = Number.isFinite(perIpPerHour) && perIpPerHour > 0 ? Math.floor(perIpPerHour) : 0;
    const globalLimit = Number.isFinite(globalPerDay) && globalPerDay > 0 ? Math.floor(globalPerDay) : 0;
    const concurrencyLimit = Number.isFinite(maxInFlight) && maxInFlight > 0 ? Math.floor(maxInFlight) : 0;
    if (perIpLimit === 0 && globalLimit === 0 && concurrencyLimit === 0) return { ok: true };

    const timestamp = Number.isFinite(at) ? Math.trunc(at) : Date.now();
    // Namespace the digest so the database never stores the source address and
    // the same address maps consistently across restarts and server processes.
    const normalizedIp = ip.trim().toLowerCase() || "unknown";
    const ipHash = createHash("sha256")
      .update("arxiblog-chat-quota:v1\0")
      .update(normalizedIp)
      .digest("hex");
    const reservationId = randomUUID();
    const dayStart = Math.floor(timestamp / DAY_MS) * DAY_MS;
    const hourStart = timestamp - HOUR_MS;

    const reserve = this.db.transaction((): ChatQuotaReservation => {
      // Turn abandoned reservations into failed attempts. They continue to
      // count against the per-IP abuse window, but no longer consume global
      // paid quota.
      this.db.prepare(
        `UPDATE chat_quota_events
         SET status='failed', settled_at_ms=?
         WHERE status='pending' AND reserved_at_ms <= ?`
      ).run(timestamp, timestamp - CHAT_QUOTA_RESERVATION_TTL_MS);

      // Keep today's global successes and the current rolling IP window. This
      // cleanup is part of admission so deployments need no maintenance job.
      const retentionFloor = Math.min(dayStart, hourStart);
      this.db.prepare(
        `DELETE FROM chat_quota_events
         WHERE (status='failed' AND reserved_at_ms <= ?)
            OR (status IN ('pending', 'succeeded') AND reserved_at_ms < ?)`
      ).run(hourStart, retentionFloor);

      if (concurrencyLimit > 0) {
        const row = this.db.prepare(
          "SELECT COUNT(*) AS count FROM chat_quota_events WHERE status='pending'"
        ).get() as { count: number };
        if (row.count >= concurrencyLimit) return { ok: false, reason: "concurrency" };
      }

      if (globalLimit > 0) {
        const row = this.db.prepare(
          `SELECT COUNT(*) AS count
           FROM chat_quota_events
           WHERE reserved_at_ms >= ? AND reserved_at_ms < ?
             AND status IN ('pending', 'succeeded')`
        ).get(dayStart, dayStart + DAY_MS) as { count: number };
        if (row.count >= globalLimit) return { ok: false, reason: "global" };
      }

      if (perIpLimit > 0) {
        const row = this.db.prepare(
          `SELECT COUNT(*) AS count
           FROM chat_quota_events
           WHERE ip_hash = ? AND reserved_at_ms > ?`
        ).get(ipHash, hourStart) as { count: number };
        if (row.count >= perIpLimit) return { ok: false, reason: "ip" };
      }

      this.db.prepare(
        `INSERT INTO chat_quota_events
           (reservation_id, ip_hash, reserved_at_ms, status)
         VALUES (?, ?, ?, 'pending')`
      ).run(reservationId, ipHash, timestamp);
      return { ok: true, reservationId };
    });

    // BEGIN IMMEDIATE serializes the check-and-insert across every SQLite
    // connection, preventing two Bun processes from racing past the cap.
    return reserve.immediate();
  }

  /** Settle once. Repeated/late callbacks are harmless. */
  settleChatQuota(reservationId: string | undefined, success: boolean, at = Date.now()): void {
    if (!reservationId) return;
    const timestamp = Number.isFinite(at) ? Math.trunc(at) : Date.now();
    const settle = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE chat_quota_events
         SET status=?, settled_at_ms=?
         WHERE reservation_id=? AND status='pending'`
      ).run(success ? "succeeded" : "failed", timestamp, reservationId);
    });
    settle.immediate();
  }
}
