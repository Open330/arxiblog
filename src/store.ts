import { Database } from "bun:sqlite";

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
CREATE INDEX IF NOT EXISTS idx_posts_paper ON posts(paper_id);
CREATE INDEX IF NOT EXISTS idx_annotations_post ON annotations(post_id);
`;

export class Store {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
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
  }): Post {
    // One post per paper: drop any stale post for this paper whose slug differs
    // (e.g. re-running `add` produced a slightly different title → new slug).
    // Annotations cascade-delete via the post FK.
    this.db.prepare("DELETE FROM posts WHERE paper_id = ? AND slug <> ?").run(p.paper_id, p.slug);
    this.db
      .prepare(
        `INSERT INTO posts (paper_id, slug, title, subtitle, tldr, takeaways, level, reading_minutes, content, persona)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           paper_id=excluded.paper_id, title=excluded.title, subtitle=excluded.subtitle,
           tldr=excluded.tldr, takeaways=excluded.takeaways, level=excluded.level,
           reading_minutes=excluded.reading_minutes, content=excluded.content, persona=excluded.persona`
      )
      .run(
        p.paper_id,
        p.slug,
        p.title,
        p.subtitle,
        p.tldr,
        JSON.stringify(p.takeaways),
        p.level,
        p.reading_minutes,
        p.content,
        p.persona
      );
    return this.db.prepare("SELECT * FROM posts WHERE slug=?").get(p.slug) as Post;
  }

  getPost(slug: string): Post | null {
    return (this.db.prepare("SELECT * FROM posts WHERE slug=?").get(slug) as Post) ?? null;
  }

  getPostByPaper(paperId: number): Post | null {
    return (this.db.prepare("SELECT * FROM posts WHERE paper_id=? ORDER BY id DESC LIMIT 1").get(paperId) as Post) ?? null;
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
    this.db.prepare("DELETE FROM annotations WHERE post_id=?").run(postId);
    const insert = this.db.prepare("INSERT INTO annotations (post_id, term, kind, explanation) VALUES (?, ?, ?, ?)");
    const tx = this.db.transaction((rows: typeof annotations) => {
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
}
