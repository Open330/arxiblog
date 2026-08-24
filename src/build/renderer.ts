import {
  mkdirSync,
  rmSync,
  cpSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { basename, join, dirname } from "path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { resolveBuildOutputDir, type ArxiblogConfig } from "../config";
import type { Store, Annotation } from "../store";
import { renderPostPage, renderIndexPage, renderNotFoundPage, safePublicUrl } from "./templates";
import { renderFeed } from "./feed";
import { writeOgImages, ogPngEnabled } from "./og";
import { escapeHtml, splitCategories } from "../utils";

function normalizeTerm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export type BuildStore = Pick<Store, "listPosts" | "getAnnotations">;

function dependencyAsset(specifier: string): string {
  try {
    return Bun.resolveSync(specifier, import.meta.dir);
  } catch (error) {
    throw new Error(
      `정적 자산 패키지를 찾을 수 없습니다 (${specifier}). 먼저 bun install을 실행하세요.`,
      { cause: error }
    );
  }
}

function dependencyLicense(packageName: string): string {
  return join(dirname(dependencyAsset(`${packageName}/package.json`)), "LICENSE");
}

/**
 * Copy only the browser assets used by generated pages. In particular, do not
 * publish Mermaid's ~83 MB distribution or KaTeX's legacy font formats.
 */
function copyVendorAssets(staticDir: string, needs: { math: boolean; mermaid: boolean }): void {
  const vendorDir = join(staticDir, "vendor");
  const pretendardDir = join(vendorDir, "pretendard");
  mkdirSync(pretendardDir, { recursive: true });

  // Regular + bold cover the UI's body and emphasis/headline use without
  // shipping nine near-800 KB static faces. Intermediate weights map to the
  // nearest local face, while the system stack remains a no-JS fallback.
  copyFileSync(
    dependencyAsset("@fontsource/pretendard/files/pretendard-latin-400-normal.woff2"),
    join(pretendardDir, "Pretendard-Regular.woff2")
  );
  copyFileSync(
    dependencyAsset("@fontsource/pretendard/files/pretendard-latin-700-normal.woff2"),
    join(pretendardDir, "Pretendard-Bold.woff2")
  );
  copyFileSync(dependencyLicense("@fontsource/pretendard"), join(pretendardDir, "LICENSE.txt"));

  if (needs.math) {
    const katexDir = join(vendorDir, "katex");
    const katexFontsDir = join(katexDir, "fonts");
    mkdirSync(katexFontsDir, { recursive: true });
    const katexCssSource = dependencyAsset("katex/dist/katex.min.css");
    const katexDistDir = dirname(katexCssSource);
    const sourceCss = readFileSync(katexCssSource, "utf-8");
    // Every supported target understands WOFF2. Removing the later WOFF/TTF
    // fallbacks saves ~800 KB from every generated site without changing KaTeX.
    const katexCss = sourceCss.replace(
      /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g,
      ""
    );
    if (/url\(fonts\/[^)]+\.(?:woff|ttf)\)/.test(katexCss)) {
      throw new Error("지원하지 않는 KaTeX 글꼴 참조 형식입니다. 고정 버전 자산을 확인하세요.");
    }
    writeFileSync(join(katexDir, "katex.min.css"), katexCss);

    const katexFontNames = new Set(
      [...katexCss.matchAll(/url\(fonts\/([^)'"]+\.woff2)\)/g)].map((match) => match[1])
    );
    if (katexFontNames.size === 0) {
      throw new Error("KaTeX CSS에서 WOFF2 글꼴을 찾지 못했습니다.");
    }
    for (const fontName of katexFontNames) {
      copyFileSync(join(katexDistDir, "fonts", fontName), join(katexFontsDir, fontName));
    }
    copyFileSync(dependencyAsset("katex/dist/katex.min.js"), join(katexDir, "katex.min.js"));
    copyFileSync(
      dependencyAsset("katex/dist/contrib/auto-render.min.js"),
      join(katexDir, "auto-render.min.js")
    );
    copyFileSync(dependencyLicense("katex"), join(katexDir, "LICENSE.txt"));
  }

  // The classic build is a single self-contained browser bundle. The smaller
  // ESM entry imports more than 200 chunks, so copying it alone is not offline.
  if (needs.mermaid) {
    const mermaidDir = join(vendorDir, "mermaid");
    mkdirSync(mermaidDir, { recursive: true });
    copyFileSync(
      dependencyAsset("mermaid/dist/mermaid.min.js"),
      join(mermaidDir, "mermaid.min.js")
    );
    copyFileSync(dependencyLicense("mermaid"), join(mermaidDir, "LICENSE.txt"));
  }
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
 * Render a post's Markdown into safe HTML. Code stays literal, annotation
 * markers become escaped popovers, and math/diagram source is restored only
 * after sanitization.
 */
interface RenderedPostBody {
  html: string;
  hasMath: boolean;
  hasMermaid: boolean;
}

function protectFencedBlocks(
  markdown: string,
  tokenNamespace: string,
  mermaidBlocks: string[],
  codePlaceholders: string[]
): string {
  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length;) {
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    // CommonMark does not allow a backtick in a backtick fence's info string.
    if (!opening || (opening[1][0] === "`" && opening[2].includes("`"))) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const marker = opening[1][0];
    const openingLength = opening[1].length;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const closing = lines[candidate].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === marker && closing[1].length >= openingLength) {
        closingIndex = candidate;
        break;
      }
    }

    // An unclosed fenced block extends to EOF under CommonMark.
    const blockEnd = closingIndex >= 0 ? closingIndex + 1 : lines.length;
    const bodyEnd = closingIndex >= 0 ? closingIndex : lines.length;
    const block = lines.slice(index, blockEnd).join("\n");
    const body = lines.slice(index + 1, bodyEnd).join("\n");
    const info = opening[2].trim();
    if (/^mermaid(?:\s|$)/i.test(info)) {
      mermaidBlocks.push(body);
      // Blank lines keep a block token out of a surrounding Markdown
      // paragraph when a fence interrupts prose without blank lines.
      output.push("", `%%${tokenNamespace}MERMAID${mermaidBlocks.length - 1}%%`, "");
    } else {
      codePlaceholders.push(block);
      // Fenced code is restored before marked parses the document. Keep the
      // placeholder exactly where the fence was so tight-list semantics and
      // surrounding paragraph layout remain unchanged.
      output.push(`%%${tokenNamespace}CODE${codePlaceholders.length - 1}%%`);
    }
    index = blockEnd;
  }

  return output.join("\n");
}

async function renderPostBodyWithAssets(content: string, annotations: Annotation[]): Promise<RenderedPostBody> {
  const annotMap = new Map<string, Annotation>();
  for (const a of annotations) annotMap.set(normalizeTerm(a.term), a);

  let markdown = content;
  // A per-render namespace prevents literal prose such as `%%ANNOT0%%` from
  // colliding with internal placeholders and duplicating/moving rich content.
  const tokenNamespace = `ARXIBLOG${crypto.randomUUID().replace(/-/g, "")}`;

  // Classify real outer fences in one pass. This prevents a ```mermaid example
  // nested inside a four-backtick Markdown fence from becoming a live diagram.
  const mermaidBlocks: string[] = [];
  const codePlaceholders: string[] = [];
  markdown = protectFencedBlocks(markdown, tokenNamespace, mermaidBlocks, codePlaceholders);
  // Preserve inline code before looking for math or [[annotation]] syntax.
  // Restore original Markdown immediately before marked() so it still receives
  // normal code rendering and sanitization.
  markdown = markdown.replace(/(`+)([\s\S]*?)\1/g, (code) => {
    codePlaceholders.push(code);
    return `%%${tokenNamespace}CODE${codePlaceholders.length - 1}%%`;
  });

  // Protect LaTeX math from marked(). Block math first, then inline.
  const mathPlaceholders: string[] = [];
  markdown = markdown.replace(/\$\$[\s\S]+?\$\$/g, (m) => {
    mathPlaceholders.push(m);
    return `%%${tokenNamespace}MATHB${mathPlaceholders.length - 1}%%`;
  });
  // Inline math: reject currency/prose false positives — require no whitespace
  // immediately inside the delimiters, and reject bare numbers like "$5".
  markdown = markdown.replace(/\$(?!\$)([^\n$]+?)\$/g, (m, inner: string) => {
    if (/^\s|\s$/.test(inner) || /^[\d.,\s]+$/.test(inner)) return m;
    mathPlaceholders.push(m);
    return `%%${tokenNamespace}MATHI${mathPlaceholders.length - 1}%%`;
  });

  // Protect [[term]] annotation markers; restore the spans after sanitize.
  const annotTokens: Array<{ html: string; literal: string }> = [];
  markdown = markdown.replace(/\[\[([^\]|]+?)\]\]/g, (_m, term: string) => {
    const t = term.trim();
    const a = findAnnotation(annotMap, annotations, t);
    annotTokens.push({
      html: a
        ? `<span class="annot" data-kind="${escapeHtml(a.kind)}" tabindex="0">${escapeHtml(t)}<span class="annot-pop"><span class="annot-term">${escapeHtml(t)}</span>${escapeHtml(a.explanation)}</span></span>`
        : escapeHtml(t), // no matching gloss → plain text, not a dead interactive span
      literal: `[[${t}]]`,
    });
    return `%%${tokenNamespace}ANNOT${annotTokens.length - 1}%%`;
  });

  markdown = markdown.replace(new RegExp(`%%${tokenNamespace}CODE(\\d+)%%`, "g"), (_m, idx) =>
    codePlaceholders[parseInt(idx, 10)] || ""
  );

  let html = await marked(markdown);

  html = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "details", "summary", "del", "s", "sup", "sub",
      "span", "div", "section", "figure", "figcaption", "mark", "pre", "code",
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["id", "class"],
      a: ["href", "title", "target", "rel"],
      span: ["class", "data-kind", "tabindex"],
      pre: ["class"],
      code: ["class"],
    },
    // %%ANNOT%% / %%MATH%% tokens are plain text and pass through untouched.
    allowedSchemes: ["http", "https", "mailto"],
  });

  // Restore annotation spans after sanitize (trusted, internally escaped
  // markup), except inside code/pre. This covers CommonMark indented code
  // without rewriting Markdown indentation or changing paragraph/list meaning.
  const annotPattern = new RegExp(`%%${tokenNamespace}ANNOT(\\d+)%%`, "g");
  html = html
    .split(/(<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>)/gi)
    .map((segment) => {
      const isCode = /^<(?:pre|code)\b/i.test(segment);
      return segment.replace(annotPattern, (_m, idx) => {
        const annotation = annotTokens[parseInt(idx, 10)];
        if (!annotation) return "";
        return isCode ? escapeHtml(annotation.literal) : annotation.html;
      });
    })
    .join("");

  // Restore math AFTER sanitize, HTML-escaping the delimiters' contents: this keeps
  // sanitize from mangling '<'/'>' inside formulas and prevents any raw tag from
  // reaching the DOM. KaTeX auto-render reads textContent, which decodes entities back.
  html = html.replace(new RegExp(`%%${tokenNamespace}MATH([BI])(\\d+)%%`, "g"), (_m, _t, idx) =>
    escapeHtml(mathPlaceholders[parseInt(idx, 10)] || "")
  );

  // Restore mermaid diagrams after sanitize. The source is HTML-escaped so no raw
  // tag reaches the DOM; mermaid.js reads textContent (entities decoded) to render.
  html = html.replace(new RegExp(`(?:<p>\\s*)?%%${tokenNamespace}MERMAID(\\d+)%%(?:\\s*<\\/p>)?`, "g"), (_m, idx) => {
    const body = mermaidBlocks[parseInt(idx, 10)] || "";
    return body.trim() ? `<pre class="mermaid">${escapeHtml(body.trim())}</pre>` : "";
  });

  return {
    html,
    hasMath: mathPlaceholders.length > 0,
    hasMermaid: mermaidBlocks.some((body) => body.trim().length > 0),
  };
}

export async function renderPostBody(content: string, annotations: Annotation[]): Promise<string> {
  return (await renderPostBodyWithAssets(content, annotations)).html;
}

function stripFencedCode(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      if (fence) {
        const close = line.match(/^ {0,3}(`+|~+)\s*$/);
        if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
        return "";
      }
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) {
        fence = { marker: open[1][0] as "`" | "~", length: open[1].length };
        return "";
      }
      return line;
    })
    .join("\n");
}

/** Generate a table of contents from ## / ### headings in the markdown (with id de-duplication). */
export function generateToc(markdown: string): Array<{ level: number; text: string; id: string }> {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const seen = new Map<string, number>();
  // Strip fenced code/mermaid blocks first: a `##` line inside a fence is NOT a heading,
  // and counting it would desync injectHeadingIds' positional id assignment.
  const scanned = stripFencedCode(markdown);
  const re = /^(#{2,3})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scanned)) !== null) {
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

async function renderSiteInto(
  store: BuildStore,
  config: ArxiblogConfig,
  projectRoot: string,
  outputDir: string
): Promise<number> {
  const postsDir = join(outputDir, "p");
  const staticDir = join(outputDir, "static");

  mkdirSync(postsDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });

  const assetsDir = join(dirname(import.meta.path), "static");
  if (existsSync(assetsDir)) cpSync(assetsDir, staticDir, { recursive: true });

  const posts = store.listPosts();
  let siteHasMath = false;
  let siteHasMermaid = false;
  // Precompute each post's category Set once (avoids O(n^2) re-splitting in the loop).
  const catSets = new Map<string, Set<string>>();
  for (const p of posts) catSets.set(p.slug, new Set(splitCategories(p.categories)));

  // Open Graph cards live at /og/<slug>.(png|svg). og:image needs an absolute
  // URL, so it is only emitted when a public site URL is configured.
  const ogDir = join(outputDir, "og");
  mkdirSync(ogDir, { recursive: true });
  const ogBase = (safePublicUrl(config.project.url) || "").replace(/\/$/, "");
  // Generate every OG card up front with a single shared browser (one launch,
  // not one per post — the per-post launch blew build/test timeouts).
  const ogPaths = await writeOgImages(posts, config, ogDir, ogPngEnabled());

  for (const post of posts) {
    const annotations = store.getAnnotations(post.id);
    const toc = generateToc(post.content);
    const renderedBody = await renderPostBodyWithAssets(post.content, annotations);
    const bodyHtml = injectHeadingIds(renderedBody.html, toc);
    siteHasMath ||= renderedBody.hasMath;
    siteHasMermaid ||= renderedBody.hasMermaid;

    // Related: other posts sharing the most arXiv categories (fallback: most recent).
    const mine = catSets.get(post.slug)!;
    const related = posts
      .filter((p) => p.slug !== post.slug)
      .map((p) => ({ p, overlap: [...catSets.get(p.slug)!].filter((c) => mine.has(c)).length }))
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3)
      .filter((x) => x.overlap > 0 || posts.length <= 4)
      .map((x) => ({
        slug: x.p.slug,
        title: x.p.title,
        arxiv_id: x.p.arxiv_id,
        reading_minutes: x.p.reading_minutes,
      }));

    const ogPath = ogPaths.get(post.slug) ?? "";
    const ogImage = ogBase && ogPath ? `${ogBase}${ogPath}` : "";
    const rawEn = (post as { translation_en?: string }).translation_en;
    const hasTranslation = !!(rawEn && rawEn.trim());

    const html = renderPostPage({
      config,
      post,
      bodyHtml,
      toc,
      annotations,
      hasMath: renderedBody.hasMath,
      hasMermaid: renderedBody.hasMermaid,
      related,
      ogImage,
      hasTranslation,
    });
    await Bun.write(join(postsDir, `${post.slug}.html`), html);

    // English variant page — reuses the same annotations (KO [[term]] markers are
    // preserved in the translation). Skipped if the stored JSON is malformed.
    if (hasTranslation) {
      try {
        const enData = JSON.parse(rawEn!) as {
          title: string; subtitle: string; tldr: string;
          takeaways: string[]; content: string; who_should_read: string;
        };
        if (enData?.content?.trim()) {
          const enToc = generateToc(enData.content);
          const enRendered = await renderPostBodyWithAssets(enData.content, annotations);
          const enBody = injectHeadingIds(enRendered.html, enToc);
          const enHtml = renderPostPage({
            config, post, bodyHtml: enBody, toc: enToc, annotations,
            hasMath: enRendered.hasMath, hasMermaid: enRendered.hasMermaid,
            ogImage, lang: "en", en: enData, hasTranslation: true,
          });
          await Bun.write(join(postsDir, `${post.slug}.en.html`), enHtml);
        }
      } catch { /* skip EN page */ }
    }
  }

  copyVendorAssets(staticDir, { math: siteHasMath, mermaid: siteHasMermaid });

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

  // RSS 2.0 feed. Always written; item links are absolute when project.url is
  // set, otherwise root-relative so a locally served site still has a valid feed.
  await Bun.write(join(outputDir, "feed.xml"), renderFeed(config, posts));

  // 404 page (GitHub Pages serves /404.html; serve mode also uses it)
  await Bun.write(join(outputDir, "404.html"), renderNotFoundPage(config));

  // Favicon — a self-contained SVG mark (no external asset)
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#4f46e5"/>
  <text x="32" y="44" font-family="-apple-system,Segoe UI,sans-serif" font-size="38" font-weight="800" fill="#fff" text-anchor="middle">a</text>
</svg>`;
  await Bun.write(join(outputDir, "favicon.svg"), favicon);

  // robots.txt + sitemap.xml (sitemap only when an absolute site URL is configured)
  const siteUrl = safePublicUrl(config.project.url);
  await Bun.write(
    join(outputDir, "robots.txt"),
    `User-agent: *\nAllow: /\n${siteUrl ? `Sitemap: ${siteUrl}sitemap.xml\n` : ""}`
  );
  if (siteUrl) {
    const urls = [siteUrl, ...posts.map((p) => new URL(`p/${encodeURIComponent(p.slug)}.html`, siteUrl).href)];
    const sitemap =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join("\n") +
      `\n</urlset>\n`;
    await Bun.write(join(outputDir, "sitemap.xml"), sitemap);
  }

  return posts.length;
}

/**
 * Build into a sibling staging directory and only replace the live site after
 * every page and asset was written successfully. A failed render therefore
 * leaves the previously working site available to `serve` and deploy tooling.
 */
export async function buildSite(store: BuildStore, config: ArxiblogConfig, projectRoot: string): Promise<number> {
  const outputDir = resolveBuildOutputDir(projectRoot, config.build.output_dir);
  const parentDir = dirname(outputDir);
  const nonce = `${process.pid}-${crypto.randomUUID()}`;
  const stagingDir = join(parentDir, `.${basename(outputDir)}.tmp-${nonce}`);
  const backupDir = join(parentDir, `.${basename(outputDir)}.old-${nonce}`);

  mkdirSync(parentDir, { recursive: true });
  try {
    const count = await renderSiteInto(store, config, projectRoot, stagingDir);
    let backedUp = false;
    try {
      if (existsSync(outputDir)) {
        renameSync(outputDir, backupDir);
        backedUp = true;
      }
      renameSync(stagingDir, outputDir);
    } catch (error) {
      // If final installation fails after moving the old site, put it back.
      if (backedUp && !existsSync(outputDir) && existsSync(backupDir)) {
        renameSync(backupDir, outputDir);
      }
      throw error;
    }

    // The new site is live. Failure to remove an old backup is not a failed build.
    if (backedUp && existsSync(backupDir)) {
      try {
        rmSync(backupDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`이전 빌드 백업을 정리하지 못했습니다: ${(error as Error).message}`);
      }
    }
    return count;
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  }
}
