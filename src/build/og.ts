import { writeFileSync } from "fs";
import { join } from "path";
import type { ArxiblogConfig } from "../config";
import type { Post } from "../store";
import { escapeHtml } from "../utils";

const WIDTH = 1200;
const HEIGHT = 630;
const ACCENT = "#4f46e5";
// A dark card so white text reads well as a social thumbnail.
const BG_TOP = "#0f1020";
const BG_BOTTOM = "#1e1b3a";
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

/** Rough per-character advance in "units" (CJK is ~twice as wide as Latin). */
function charUnits(ch: string): number {
  return /[ᄀ-ᇿ　-鿿가-힯豈-﫿]/.test(ch) ? 1 : 0.55;
}

function textWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += charUnits(ch);
  return total;
}

/**
 * Greedy word-wrap that also hard-splits over-long tokens (e.g. spaceless
 * Korean titles). Used only for the SVG fallback, where the browser cannot lay
 * text out for us. Truncates to `maxLines` and appends an ellipsis if clipped.
 */
function wrapTitle(text: string, maxUnits: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  let overflow = false;
  const tokens = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  outer: for (const token of tokens) {
    if (lines.length >= maxLines) {
      overflow = true;
      break;
    }
    const candidate = current ? `${current} ${token}` : token;
    if (textWidth(candidate) <= maxUnits) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    // The token alone overflows a line: break it character by character.
    let chunk = "";
    for (const ch of token) {
      if (chunk && textWidth(chunk + ch) > maxUnits) {
        if (lines.length >= maxLines) {
          overflow = true;
          chunk = "";
          break outer;
        }
        lines.push(chunk);
        chunk = "";
      }
      chunk += ch;
    }
    current = chunk;
  }
  if (current) {
    if (lines.length < maxLines) lines.push(current);
    else overflow = true;
  }

  if (overflow && lines.length) {
    const last = lines[lines.length - 1].replace(/\s+$/, "");
    lines[lines.length - 1] = `${last.length > 1 ? last.slice(0, -1) : last}…`;
  }
  return lines;
}

function cardTitle(post: Post): string {
  const raw = (post.title || "").trim();
  return raw || "arXiv paper";
}

function arxivLabel(post: Post): string {
  const id = (post.arxiv_id || "").trim();
  return id ? `arXiv:${id}` : "arXiv";
}

/** Self-contained HTML card rendered by Playwright, screenshotted to PNG. */
function cardHtml(post: Post, siteName: string): string {
  const title = escapeHtml(cardTitle(post));
  const badge = escapeHtml(arxivLabel(post));
  const brand = escapeHtml(siteName || "arxiblog");
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  .card {
    width: ${WIDTH}px; height: ${HEIGHT}px; padding: 84px 88px;
    background: linear-gradient(135deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%);
    color: #ffffff; font-family: ${FONT_STACK};
    display: flex; flex-direction: column; justify-content: space-between;
    position: relative; overflow: hidden;
  }
  .accent-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 16px; background: ${ACCENT}; }
  .brand { font-size: 34px; font-weight: 800; letter-spacing: -0.5px; color: #c7d2fe; }
  .brand b { color: #a5b4fc; }
  .title {
    font-size: 66px; font-weight: 800; line-height: 1.16; letter-spacing: -1.5px;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .badge {
    align-self: flex-start; background: ${ACCENT}; color: #ffffff;
    padding: 12px 26px; border-radius: 999px; font-weight: 700; font-size: 30px;
  }
</style></head>
<body><div class="card">
  <div class="accent-bar"></div>
  <div class="brand">arxi<b>blog</b> · ${brand}</div>
  <div class="title">${title}</div>
  <div class="badge">${badge}</div>
</div></body></html>`;
}

/** Self-contained SVG card, used when Playwright is unavailable. */
function cardSvg(post: Post, siteName: string): string {
  const brand = escapeHtml(`arxiblog · ${siteName || "arxiblog"}`);
  const badge = escapeHtml(arxivLabel(post));
  const lines = wrapTitle(cardTitle(post), 17, 4);
  const titleTop = 250;
  const lineHeight = 78;
  const titleSvg = lines
    .map((line, index) => `<text x="88" y="${titleTop + index * lineHeight}">${escapeHtml(line)}</text>`)
    .join("\n    ");
  const badgeWidth = Math.round(textWidth(badge) * 20) + 52;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect x="0" y="0" width="16" height="${HEIGHT}" fill="${ACCENT}"/>
  <text x="88" y="130" font-family="${FONT_STACK}" font-size="34" font-weight="800" fill="#c7d2fe">${brand}</text>
  <g font-family="${FONT_STACK}" font-size="64" font-weight="800" fill="#ffffff">
    ${titleSvg}
  </g>
  <rect x="88" y="520" width="${badgeWidth}" height="60" rx="30" fill="${ACCENT}"/>
  <text x="${88 + badgeWidth / 2}" y="560" font-family="${FONT_STACK}" font-size="30" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${badge}</text>
</svg>
`;
}

/**
 * Generate a 1200x630 branded Open Graph card for a post.
 *
 * Prefers a rasterized PNG via Playwright (crisp system-font layout); falls back
 * to a self-contained SVG when Playwright is unavailable. Any failure returns ""
 * so the caller simply omits the og:image tag.
 *
 * @param outDir filesystem path of the site's `/og` directory
 * @returns the site-root-relative public path (e.g. "/og/<slug>.png"), or ""
 */
export async function writeOgImage(post: Post, config: ArxiblogConfig, outDir: string): Promise<string> {
  const siteName = config.project.name || "arxiblog";
  const slug = post.slug;
  const publicPath = (ext: string) => `/og/${encodeURIComponent(slug)}.${ext}`;

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
      });
      await page.setContent(cardHtml(post, siteName), { waitUntil: "load" });
      await page.screenshot({
        path: join(outDir, `${slug}.png`),
        type: "png",
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });
      return publicPath("png");
    } finally {
      await browser.close();
    }
  } catch {
    // Playwright missing or a browser launch failure: fall back to SVG.
    try {
      writeFileSync(join(outDir, `${slug}.svg`), cardSvg(post, siteName));
      return publicPath("svg");
    } catch {
      return "";
    }
  }
}
