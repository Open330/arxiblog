import { mkdirSync, rmSync, cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { ArxiblogConfig } from "../config";
import type { Store, Post, Annotation } from "../store";
import { renderPostPage, renderIndexPage } from "./templates";
import { escapeHtml } from "../utils";

function normalizeTerm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Find an annotation for a [[marker]], with a substring fallback for inflected/expanded phrases. */
function findAnnotation(map: Map<string, Annotation>, list: Annotation[], term: string): Annotation | null {
  const t = normalizeTerm(term);
  const exact = map.get(t);
  if (exact) return exact;
  // Fallback: longest annotation term that contains, or is contained by, the marker.
  let best: Annotation | null = null;
  for (const a of list) {
    const at = normalizeTerm(a.term);
    if (!at) continue;
    if (t.includes(at) || at.includes(t)) {
      if (!best || a.term.length > best.term.length) best = a;
    }
  }
  return best;
}

/**
 * Render a post's markdown body into safe HTML.
 * - [[term]] markers become annotation spans with a popover (looked up from `annotations`).
 * - $...$ / $$...$$ math is protected from markdown, then re-inserted (HTML-escaped) AFTER
 *   sanitization so KaTeX sees the raw delimiters while no raw tag ever reaches the DOM.
 */
export async function renderPostBody(content: string, annotations: Annotation[]): Promise<string> {
  const annotMap = new Map<string, Annotation>();
  for (const a of annotations) annotMap.set(normalizeTerm(a.term), a);

  let markdown = content;

  // Protect ```mermaid fenced blocks first (before math/annotation passes touch
  // their contents). Restored after sanitize as <pre class="mermaid"> for mermaid.js.
  const mermaidBlocks: string[] = [];
  markdown = markdown.replace(/```mermaid\s*\n([\s\S]*?)```/g, (_m, body: string) => {
    mermaidBlocks.push(body);
    return `\n\n%%MERMAID${mermaidBlocks.length - 1}%%\n\n`;
  });

  // Protect LaTeX math from marked(). Block math first, then inline.
  const mathPlaceholders: string[] = [];
  markdown = markdown.replace(/\$\$[\s\S]+?\$\$/g, (m) => {
    mathPlaceholders.push(m);
    return `%%MATHB${mathPlaceholders.length - 1}%%`;
  });
  // Inline math: reject currency/prose false positives — require no whitespace
  // immediately inside the delimiters, and reject bare numbers like "$5".
  markdown = markdown.replace(/\$(?!\$)([^\n$]+?)\$/g, (m, inner: string) => {
    if (/^\s|\s$/.test(inner) || /^[\d.,\s]+$/.test(inner)) return m;
    mathPlaceholders.push(m);
    return `%%MATHI${mathPlaceholders.length - 1}%%`;
  });

  // Protect [[term]] annotation markers; restore the spans after sanitize.
  const annotTokens: string[] = [];
  markdown = markdown.replace(/\[\[([^\]|]+?)\]\]/g, (_m, term: string) => {
    const t = term.trim();
    const a = findAnnotation(annotMap, annotations, t);
    annotTokens.push(
      a
        ? `<span class="annot" data-kind="${escapeHtml(a.kind)}" tabindex="0">${escapeHtml(t)}<span class="annot-pop"><span class="annot-term">${escapeHtml(t)}</span>${escapeHtml(a.explanation)}</span></span>`
        : escapeHtml(t) // no matching gloss → plain text, not a dead interactive span
    );
    return `%%ANNOT${annotTokens.length - 1}%%`;
  });

  let html = await marked(markdown);

  html = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img", "details", "summary", "del", "s", "sup", "sub",
      "span", "div", "section", "figure", "figcaption", "mark", "pre", "code",
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["id", "class"],
      img: ["src", "alt", "title", "width", "height"],
      a: ["href", "title", "target", "rel"],
      span: ["class", "data-kind", "tabindex"],
      pre: ["class"],
      code: ["class"],
    },
    // %%ANNOT%% / %%MATH%% tokens are plain text and pass through untouched.
    allowedSchemes: ["http", "https", "mailto"],
  });

  // Restore annotation spans after sanitize (trusted, internally escaped markup).
  html = html.replace(/%%ANNOT(\d+)%%/g, (_m, idx) => annotTokens[parseInt(idx, 10)] || "");

  // Restore math AFTER sanitize, HTML-escaping the delimiters' contents: this keeps
  // sanitize from mangling '<'/'>' inside formulas and prevents any raw tag from
  // reaching the DOM. KaTeX auto-render reads textContent, which decodes entities back.
  html = html.replace(/%%MATH([BI])(\d+)%%/g, (_m, _t, idx) => escapeHtml(mathPlaceholders[parseInt(idx, 10)] || ""));

  // Restore mermaid diagrams after sanitize. The source is HTML-escaped so no raw
  // tag reaches the DOM; mermaid.js reads textContent (entities decoded) to render.
  html = html.replace(/(?:<p>\s*)?%%MERMAID(\d+)%%(?:\s*<\/p>)?/g, (_m, idx) => {
    const body = mermaidBlocks[parseInt(idx, 10)] || "";
    return body.trim() ? `<pre class="mermaid">${escapeHtml(body.trim())}</pre>` : "";
  });

  return html;
}

/** Generate a table of contents from ## / ### headings in the markdown (with id de-duplication). */
export function generateToc(markdown: string): Array<{ level: number; text: string; id: string }> {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const seen = new Map<string, number>();
  const re = /^(#{2,3})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const text = m[2].replace(/\[\[([^\]|]+?)\]\]/g, "$1").trim();
    let id = slugifyHeading(text) || "section";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    headings.push({ level: m[1].length, text, id });
  }
  return headings;
}

/**
 * marked v15 no longer emits heading `id` attributes, so the TOC anchors would be
 * dead. Assign ids positionally from the TOC (same document order, same count).
 */
export function injectHeadingIds(html: string, toc: Array<{ id: string }>): string {
  let i = 0;
  return html.replace(/<(h[23])>/g, (m, tag: string) => {
    const h = toc[i++];
    return h ? `<${tag} id="${escapeHtml(h.id)}">` : m;
  });
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s가-힣-]/g, "")
    .replace(/\s+/g, "-");
}

export async function buildSite(store: Store, config: ArxiblogConfig, projectRoot: string): Promise<number> {
  const outputDir = join(projectRoot, config.build.output_dir);
  const postsDir = join(outputDir, "p");
  const staticDir = join(outputDir, "static");

  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
  mkdirSync(postsDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });

  const assetsDir = join(dirname(import.meta.path), "static");
  if (existsSync(assetsDir)) cpSync(assetsDir, staticDir, { recursive: true });

  const posts = store.listPosts();
  const catsOf = (p: { categories?: string }) =>
    new Set((p.categories || "").split(",").map((c) => c.trim()).filter(Boolean));

  for (const post of posts) {
    const annotations = store.getAnnotations(post.id);
    const toc = generateToc(post.content);
    const bodyHtml = injectHeadingIds(await renderPostBody(post.content, annotations), toc);

    // Related: other posts sharing the most arXiv categories (fallback: most recent).
    const mine = catsOf(post);
    const related = posts
      .filter((p) => p.slug !== post.slug)
      .map((p) => ({ p, overlap: [...catsOf(p)].filter((c) => mine.has(c)).length }))
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3)
      .filter((x) => x.overlap > 0 || posts.length <= 4)
      .map((x) => ({
        slug: x.p.slug,
        title: x.p.title,
        arxiv_id: x.p.arxiv_id,
        reading_minutes: x.p.reading_minutes,
      }));

    const html = renderPostPage({ config, post, bodyHtml, toc, annotations, related });
    await Bun.write(join(postsDir, `${post.slug}.html`), html);
  }

  const indexHtml = renderIndexPage({ config, posts });
  await Bun.write(join(outputDir, "index.html"), indexHtml);

  // Search/index data for potential client use
  await Bun.write(
    join(outputDir, "posts.json"),
    JSON.stringify(
      posts.map((p) => ({
        slug: p.slug,
        title: p.title,
        subtitle: p.subtitle,
        tldr: p.tldr,
        arxiv_id: p.arxiv_id,
        categories: p.categories,
        reading_minutes: p.reading_minutes,
        level: p.level,
      }))
    )
  );

  return posts.length;
}
