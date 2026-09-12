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

/** Public slug of the site-wide default card (index page, posts without a card). */
export const SITE_OG_SLUG = "_site";

function siteHost(config: ArxiblogConfig): string {
  try {
    return config.project.url ? new URL(config.project.url).host : "";
  } catch {
    return "";
  }
}

/** Site-wide card: site name + tagline + host, same palette as the post cards. */
function siteCardHtml(config: ArxiblogConfig): string {
  const name = escapeHtml(config.project.name || "arxiblog");
  const tagline = escapeHtml(config.project.tagline || "어려운 논문을, 읽고 싶은 글로.");
  const host = escapeHtml(siteHost(config));
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
  .title { font-size: 96px; font-weight: 800; line-height: 1.1; letter-spacing: -2px; }
  .tagline { font-size: 44px; font-weight: 600; line-height: 1.3; color: #e0e7ff; margin-top: 24px; }
  .host {
    align-self: flex-start; background: ${ACCENT}; color: #ffffff;
    padding: 12px 26px; border-radius: 999px; font-weight: 700; font-size: 30px;
  }
</style></head>
<body><div class="card">
  <div class="accent-bar"></div>
  <div class="brand">arxi<b>blog</b></div>
  <div><div class="title">${name}</div><div class="tagline">${tagline}</div></div>
  ${host ? `<div class="host">${host}</div>` : ""}
</div></body></html>`;
}

function siteCardSvg(config: ArxiblogConfig): string {
  const name = wrapTitle(config.project.name || "arxiblog", 14, 2);
  const tagline = wrapTitle(config.project.tagline || "어려운 논문을, 읽고 싶은 글로.", 26, 2);
  const host = escapeHtml(siteHost(config));
  const titleSvg = name
    .map((line, index) => `<text x="88" y="${260 + index * 104}">${escapeHtml(line)}</text>`)
    .join("\n    ");
  const taglineTop = 260 + name.length * 104 - 40;
  const taglineSvg = tagline
    .map((line, index) => `<text x="88" y="${taglineTop + index * 54}">${escapeHtml(line)}</text>`)
    .join("\n    ");
  const hostWidth = Math.round(textWidth(host) * 20) + 52;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect x="0" y="0" width="16" height="${HEIGHT}" fill="${ACCENT}"/>
  <text x="88" y="130" font-family="${FONT_STACK}" font-size="34" font-weight="800" fill="#c7d2fe">arxiblog</text>
  <g font-family="${FONT_STACK}" font-size="96" font-weight="800" fill="#ffffff">
    ${titleSvg}
  </g>
  <g font-family="${FONT_STACK}" font-size="44" font-weight="600" fill="#e0e7ff">
    ${taglineSvg}
  </g>
  ${host ? `<rect x="88" y="520" width="${hostWidth}" height="60" rx="30" fill="${ACCENT}"/>
  <text x="${88 + hostWidth / 2}" y="560" font-family="${FONT_STACK}" font-size="30" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${host}</text>` : ""}
</svg>
`;
}

/**
 * Generate the site-wide 1200x630 card used by the index page (and as the
 * fallback for posts without a card). Same PNG/SVG strategy as writeOgImages.
 *
 * @returns the site-root-relative public path (e.g. "/og/_site.png"), or ""
 */
export async function writeSiteOgImage(
  config: ArxiblogConfig,
  outDir: string,
  usePng = ogPngEnabled()
): Promise<string> {
  const cards = [{ slug: SITE_OG_SLUG, html: siteCardHtml(config), svg: siteCardSvg(config) }];
  const map = await writeCards(cards, outDir, usePng);
  return map.get(SITE_OG_SLUG) ?? "";
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
  const map = await writeOgImages([post], config, outDir, ogPngEnabled());
  return map.get(post.slug) ?? "";
}

/** PNG cards need a headless Chromium (slow cold-start), so they are opt-in via
 *  ARXIBLOG_OG_PNG=1. Default builds/tests use the fast, dependency-free SVG card. */
export function ogPngEnabled(): boolean {
  const v = process.env.ARXIBLOG_OG_PNG;
  return v === "1" || v === "true";
}

/**
 * Batch variant: generate OG cards for many posts, launching Chromium ONCE and
 * reusing a single page (was: one browser launch per post — slow enough to blow
 * build/test timeouts). Falls back to SVG per-post, or for all posts when
 * Playwright is unavailable. Returns a slug → public-path map ("" entries omitted).
 */
export async function writeOgImages(
  posts: Post[],
  config: ArxiblogConfig,
  outDir: string,
  usePng = false
): Promise<Map<string, string>> {
  const siteName = config.project.name || "arxiblog";
  const cards = posts.map((post) => ({
    slug: post.slug,
    html: cardHtml(post, siteName),
    svg: cardSvg(post, siteName),
  }));
  return writeCards(cards, outDir, usePng);
}

interface OgCard {
  slug: string;
  /** Playwright-rendered HTML (PNG path). */
  html: string;
  /** Dependency-free fallback (SVG path). */
  svg: string;
}

async function writeCards(cards: OgCard[], outDir: string, usePng: boolean): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pub = (slug: string, ext: string) => `/og/${encodeURIComponent(slug)}.${ext}`;
  const svg = (card: OgCard): void => {
    try {
      writeFileSync(join(outDir, `${card.slug}.svg`), card.svg);
      result.set(card.slug, pub(card.slug, "svg"));
    } catch { /* omit og:image for this card */ }
  };
  if (cards.length === 0) return result;

  // Fast path: SVG cards (no browser). PNG is opt-in because Chromium cold-start
  // is slow enough to blow build/test timeouts.
  if (!usePng) {
    for (const card of cards) svg(card);
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    for (const card of cards) svg(card); // no Playwright → SVG for all
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    for (const card of cards) {
      try {
        await page.setContent(card.html, { waitUntil: "load" });
        await page.screenshot({
          path: join(outDir, `${card.slug}.png`),
          type: "png",
          clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        });
        result.set(card.slug, pub(card.slug, "png"));
      } catch {
        svg(card); // per-card failure → SVG fallback, keep going
      }
    }
  } catch {
    for (const card of cards) if (!result.has(card.slug)) svg(card); // launch failed
  } finally {
    try { await browser?.close(); } catch { /* best effort */ }
  }
  return result;
}
