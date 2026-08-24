import type { ArxiblogConfig } from "../config";
import type { Post } from "../store";

/**
 * Escape the five XML predefined entities. RSS item/channel text is
 * character data, so `&`, `<`, `>` and `"` must never appear raw.
 */
function xmlEscape(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Turn a stored timestamp into an RFC 822 date for <pubDate>. Posts are stored
 * with SQLite's `datetime('now')` UTC format ("YYYY-MM-DD HH:MM:SS"); normalize
 * that to ISO-8601 UTC so Date parses it unambiguously. Returns "" when the
 * value is missing or unparseable (the caller then omits <pubDate>).
 */
function toRfc822(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toUTCString();
}

/**
 * Render an RSS 2.0 feed for the generated site.
 *
 * When `project.url` is configured every link is absolute; otherwise the feed
 * is still emitted with root-relative item links so a locally served site keeps
 * a valid feed document.
 */
export function renderFeed(config: ArxiblogConfig, posts: Post[]): string {
  const base = (config.project.url || "").replace(/\/$/, "");
  const channelTitle = config.project.name || "arxiblog";
  const channelDescription = config.project.tagline || "";
  const now = new Date().toUTCString();

  const items = posts
    .map((post) => {
      const link = `${base}/p/${encodeURIComponent(post.slug)}.html`;
      const description = post.tldr || post.subtitle || "";
      const pubDate = toRfc822(post.created_at);
      // A stable, non-URL guid: the arXiv id survives slug/title changes.
      const guid = post.arxiv_id ? `arxiv:${post.arxiv_id}` : link;
      return [
        "    <item>",
        `      <title>${xmlEscape(post.title || "")}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        `      <guid isPermaLink="false">${xmlEscape(guid)}</guid>`,
        description ? `      <description>${xmlEscape(description)}</description>` : "",
        pubDate ? `      <pubDate>${pubDate}</pubDate>` : "",
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const selfLink = base
    ? `\n    <atom:link href="${xmlEscape(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(channelTitle)}</title>
    <link>${xmlEscape(base)}</link>
    <description>${xmlEscape(channelDescription)}</description>
    <language>ko</language>
    <lastBuildDate>${now}</lastBuildDate>${selfLink}
${items}
  </channel>
</rss>
`;
}
