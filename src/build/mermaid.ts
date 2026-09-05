/**
 * Build-time Mermaid rendering.
 *
 * Shipping mermaid.min.js to the browser costs ~3.4 MB on every page that holds
 * a single diagram. Rendering the diagrams here instead and inlining the SVG
 * removes that download entirely; the runtime library is only copied for pages
 * that still hold a diagram we could not pre-render.
 *
 * Like og.ts, Playwright is an optional dependency: when it is missing (or the
 * browser fails) every diagram falls back to the runtime renderer, so a build
 * never breaks because of it.
 */

/** A diagram rendered once per colour scheme; both share identical geometry. */
export interface PrerenderedDiagram {
  light: string;
  dark: string;
}

/** Keyed by the diagram's trimmed Mermaid source, so identical diagrams render once. */
export type DiagramMap = Map<string, PrerenderedDiagram>;

/** Escape hatch for environments that would rather ship the runtime library. */
export function mermaidPrerenderEnabled(): boolean {
  const value = process.env.ARXIBLOG_MERMAID_PRERENDER;
  return value !== "0" && value !== "false";
}

function dependencyAsset(specifier: string): string | null {
  try {
    return Bun.resolveSync(specifier, import.meta.dir);
  } catch {
    return null;
  }
}

/**
 * Mermaid renders author-controlled text. securityLevel "strict" already escapes
 * labels, but this SVG bypasses the Markdown sanitizer on its way into the page,
 * so anything that could execute (or embed HTML) is rejected outright and keeps
 * its runtime fallback, where sanitization still applies.
 */
function isInertSvg(svg: string): boolean {
  return svg.startsWith("<svg") && !/<script|<foreignObject|javascript:|\son[a-z]+\s*=/i.test(svg);
}

/**
 * Diagrams must be laid out with the font the visitor actually sees, otherwise
 * Mermaid's text measurements — and therefore every node box — come out the
 * wrong size. Inline the shipped WOFF2 faces as data URIs; a file:// URL would
 * be blocked from the about:blank render page.
 *
 * Encoding these two faces costs ~2 MB of base64, so it is done once per process
 * rather than once per build: `arxiblog digest` and the long-running server both
 * call this repeatedly, and re-encoding it every time was pure garbage-collector churn.
 */
let fontFaceCssCache: Promise<string> | null = null;

/**
 * Where a full Pretendard face can be found, best first.
 *
 * The site's own font pipeline (static/fonts.css and what the build copies) is
 * owned elsewhere and may move between packages, so each weight lists every
 * package that is known to ship it and the first one that resolves wins. If none
 * does, the diagrams are measured with the default sans instead of failing.
 */
const FONT_CANDIDATES: Array<{ weight: number; specifiers: string[] }> = [
  {
    weight: 400,
    specifiers: [
      "@fontsource/pretendard/files/pretendard-latin-400-normal.woff2",
      "pretendard/dist/web/static/woff2/Pretendard-Regular.woff2",
    ],
  },
  {
    weight: 700,
    specifiers: [
      "@fontsource/pretendard/files/pretendard-latin-700-normal.woff2",
      "pretendard/dist/web/static/woff2/Pretendard-Bold.woff2",
    ],
  },
];

function buildFontFaceCss(): Promise<string> {
  return (async () => {
    const blocks: string[] = [];
    for (const face of FONT_CANDIDATES) {
      const path = face.specifiers.map(dependencyAsset).find(Boolean);
      if (!path) continue;
      try {
        const base64 = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
        blocks.push(
          '@font-face{font-family:"Pretendard";font-style:normal;font-weight:' +
            face.weight +
            ';src:url(data:font/woff2;base64,' +
            base64 +
            ') format("woff2");}'
        );
      } catch {
        /* fall back to the browser's default sans for measurement */
      }
    }
    return blocks.join("\n");
  })();
}

function fontFaceCss(): Promise<string> {
  if (!fontFaceCssCache) fontFaceCssCache = buildFontFaceCss();
  return fontFaceCssCache;
}

/**
 * The outcome of the build-time pass over a site's diagrams.
 *
 * `available` is the important bit: it separates a *content* failure from an
 * *environment* failure. When the pass ran, a diagram missing from `diagrams`
 * is one Mermaid itself refused — it would fail in the reader's browser too, so
 * shipping the 3.4 MB runtime library for it buys nothing. When the pass could
 * not run at all (no Playwright, disabled, browser failed, timed out), nothing
 * is known about the diagrams and the runtime renderer is still the right
 * answer.
 */
export interface MermaidPrerender {
  available: boolean;
  diagrams: DiagramMap;
  /** Trimmed source → Mermaid's own error, for diagrams it rejected. */
  failures: Map<string, string>;
}

function unavailable(): MermaidPrerender {
  return { available: false, diagrams: new Map(), failures: new Map() };
}

// Every browser step gets an explicit ceiling. Playwright's own default timeout
// covers navigation and addScriptTag, but `page.evaluate` has NO timeout of its
// own: a font decode or a render that never settles would otherwise hang the
// build forever — and, worse, skip the cleanup that closes the browser, so the
// next build inherits a leaked Chromium. A build must never hang.
const LAUNCH_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 30_000;
/** Best-effort: on timeout we render with fallback metrics rather than give up. */
const FONT_TIMEOUT_MS = 15_000;
const RENDER_BASE_TIMEOUT_MS = 20_000;
const RENDER_PER_DIAGRAM_MS = 4_000;
const CLOSE_TIMEOUT_MS = 10_000;
/** How long a prepared page is kept alive between builds before it is released. */
const SESSION_IDLE_MS = 30_000;

/** Whole-pass ceiling, overridable for very large corpora. */
function totalBudgetMs(diagramCount: number): number {
  const override = Number(process.env.ARXIBLOG_MERMAID_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return LAUNCH_TIMEOUT_MS + SETUP_TIMEOUT_MS + FONT_TIMEOUT_MS + RENDER_BASE_TIMEOUT_MS +
    RENDER_PER_DIAGRAM_MS * diagramCount;
}

class StepTimeout extends Error {}

/** ARXIBLOG_MERMAID_DEBUG=1 prints how long each browser step took. */
const debugSteps = (): boolean => !!process.env.ARXIBLOG_MERMAID_DEBUG;

/**
 * Reject after `ms`, so no single browser call can wait forever.
 *
 * A rejection here abandons the promise but does NOT cancel the work inside the
 * browser — measured: abandoning the font decode after 300 ms pushed the very
 * next step from 321 ms to 1891 ms, because the renderer was still busy. Any
 * caller that times out must therefore throw the whole session away rather than
 * carry on against a page that is still working.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`${label} 시간 초과 (${ms}ms)`)), ms);
    // A pending guard must never be the reason the process stays alive.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, limit])
    .finally(() => {
      clearTimeout(timer);
      if (debugSteps()) console.warn(`      [mermaid] ${label}: ${Date.now() - started}ms (cap ${ms}ms)`);
    }) as Promise<T>;
}

/**
 * A prepared render page: fonts decoded, mermaid loaded, ready to render.
 *
 * The page is kept between calls because preparing one is expensive and, worse,
 * *contended*. Decoding the 750 KB / 14,336-glyph Korean face costs ~2 s in an
 * idle browser and scales with the number of Chromium instances doing it at the
 * same time — measured 2.0 s at 1x, 5.5 s at 3x, 10.9 s at 6x, while every other
 * step stayed under 260 ms. Reusing the browser does not help (a new page pays
 * the full ~2 s again); only reusing the *page* does, which drops the repeat cost
 * to 1-9 ms. `arxiblog digest` and the long-running /api/add server both call
 * this many times per process, so that repeat is what matters.
 */
interface RenderSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  /** Ids must stay unique across batches rendered on the same page. */
  batch: number;
}

let session: RenderSession | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let exitHookInstalled = false;

/** A cached browser must never outlive the process that opened it. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("beforeExit", () => {
    void disposeSession();
  });
}

function cancelIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/** Let an idle server release the browser instead of holding one forever. */
function scheduleIdleClose(): void {
  cancelIdleClose();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void disposeSession();
  }, SESSION_IDLE_MS);
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

/** Tear the session down unconditionally; a wedged page is never reused. */
async function disposeSession(): Promise<void> {
  cancelIdleClose();
  const current = session;
  session = null;
  if (!current) return;
  try {
    await withTimeout(current.page.close(), CLOSE_TIMEOUT_MS, "페이지 종료");
  } catch {
    /* closing the browser below is what actually matters */
  }
  try {
    await withTimeout(current.browser.close(), CLOSE_TIMEOUT_MS, "브라우저 종료");
  } catch {
    console.warn("⚠ 렌더링용 브라우저를 정상 종료하지 못했습니다.");
  }
}

/**
 * Return the prepared page, building one if there is none.
 *
 * @param skipFont a previous attempt stalled on the font, so this one renders
 *   with fallback metrics rather than risking the same stall again.
 */
async function acquireSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chromium: any,
  mermaidPath: string,
  budget: (stepMs: number) => number,
  skipFont: boolean
): Promise<RenderSession> {
  cancelIdleClose();
  if (session && session.browser.isConnected() && !session.page.isClosed()) return session;
  if (session) await disposeSession();
  installExitHook();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  try {
    browser = await withTimeout(
      // Crash reporting writes to a database shared with every other Chromium on
      // the machine; a build tool has no use for it.
      chromium.launch({ timeout: budget(LAUNCH_TIMEOUT_MS), args: ["--disable-breakpad"] }),
      budget(LAUNCH_TIMEOUT_MS) + 1_000,
      "Chromium 실행"
    );
    page = await withTimeout(
      browser.newPage({ viewport: { width: 1400, height: 900 } }),
      budget(SETUP_TIMEOUT_MS),
      "페이지 생성"
    );
    page.setDefaultTimeout(budget(SETUP_TIMEOUT_MS));

    const faces = await fontFaceCss();
    await withTimeout(
      page.setContent(
        '<!doctype html><html><head><meta charset="utf-8"><style>' +
          faces +
          "\nbody{margin:0;font-family:Pretendard,sans-serif;}</style></head><body></body></html>",
        { waitUntil: "load" }
      ),
      budget(SETUP_TIMEOUT_MS),
      "렌더 페이지 준비"
    );

    // Diagrams must be measured with the font the visitor sees. If there is no
    // face to load (the font package moved), or a previous attempt stalled here,
    // fall through to the default sans rather than wait on nothing.
    if (faces && !skipFont) {
      await withTimeout(
        page.evaluate(() =>
          document.fonts.load('16px "Pretendard"').then(() => document.fonts.ready).then(() => true)
        ),
        budget(FONT_TIMEOUT_MS),
        "글꼴 로드"
      );
    }

    await withTimeout(page.addScriptTag({ path: mermaidPath }), budget(SETUP_TIMEOUT_MS), "mermaid 로드");
  } catch (error) {
    // Half-built sessions are never handed out, and never left running.
    try {
      await withTimeout(browser?.close(), CLOSE_TIMEOUT_MS, "브라우저 종료");
    } catch {
      /* best effort */
    }
    throw error;
  }

  session = { browser, page, batch: 0 };
  return session;
}

/** Render one batch of sources on a prepared page. */
async function renderBatch(
  current: RenderSession,
  unique: string[],
  timeoutMs: number
): Promise<Array<{ index: number; light?: string; dark?: string; error?: string }>> {
  current.batch += 1;
  return withTimeout(
    current.page.evaluate(
      async ({ list, batch }: { list: string[]; batch: number }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mermaid = (window as any).mermaid;
        const out: Array<{ index: number; light?: string; dark?: string; error?: string }> =
          list.map((_unused, index) => ({ index }));
        const themes: Array<["light" | "dark", string]> = [
          ["light", "neutral"],
          ["dark", "dark"],
        ];
        for (const [key, theme] of themes) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme,
            fontFamily: "Pretendard, sans-serif",
            // Plain <text> labels instead of <foreignObject>: an inlined SVG has
            // to be self-contained, and it keeps author text out of an HTML
            // subtree that bypasses the Markdown sanitizer.
            htmlLabels: false,
            flowchart: { htmlLabels: false },
          });
          for (let index = 0; index < list.length; index += 1) {
            // The batch counter keeps ids unique when a reused page renders more
            // than once; a repeated id would collide with the previous SVG's CSS.
            const id = "arxiblog-mmd-" + batch + "-" + index + "-" + key;
            try {
              const { svg } = await mermaid.render(id, list[index]);
              out[index][key] = svg;
            } catch (error) {
              // Mermaid rejected the source itself — the same parse would fail in
              // a reader's browser, so record why instead of hiding it.
              const message =
                error && (error as Error).message ? (error as Error).message : String(error);
              out[index].error = message.split("\n").slice(0, 3).join(" ").slice(0, 300);
            } finally {
              // mermaid.render leaves its scratch element behind when it throws.
              document.getElementById("d" + id)?.remove();
            }
          }
        }
        return out;
      },
      { list: unique, batch: current.batch }
    ),
    timeoutMs,
    "도식 렌더"
  );
}

/**
 * Render every distinct Mermaid source to a light and a dark SVG.
 *
 * Never throws and never hangs: an environment that cannot pre-render — or one
 * that stalls — reports `available:false` and the caller falls back to the
 * runtime renderer.
 */
export async function prerenderMermaid(sources: string[]): Promise<MermaidPrerender> {
  const diagrams: DiagramMap = new Map();
  const failures = new Map<string, string>();
  const unique = [...new Set(sources.map((source) => source.trim()).filter(Boolean))];
  if (unique.length === 0) return { available: true, diagrams, failures };

  const mermaidPath = dependencyAsset("mermaid/dist/mermaid.min.js");
  if (!mermaidPath) return unavailable();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return unavailable(); // no Playwright → runtime mermaid for every diagram
  }

  const deadline = Date.now() + totalBudgetMs(unique.length);
  /**
   * Time left in the whole-pass budget, so one slow step cannot spend it all.
   * Never returns 0 or less: Playwright reads a timeout of 0 as "wait forever",
   * which is exactly the hang this budget exists to prevent.
   */
  const budget = (stepMs: number): number => Math.max(1, Math.min(stepMs, deadline - Date.now()));
  const renderCap = () => budget(RENDER_BASE_TIMEOUT_MS + RENDER_PER_DIAGRAM_MS * unique.length);

  let lastError: unknown;
  // Two attempts. A timeout leaves the page still working on whatever stalled, so
  // the session is destroyed rather than reused; the retry starts from a clean
  // browser and skips the font wait, which is the only step that contends.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const current = await acquireSession(chromium, mermaidPath, budget, attempt > 0);
      const rendered = await renderBatch(current, unique, renderCap());
      for (const item of rendered) {
        const source = unique[item.index];
        const light = item.light || "";
        const dark = item.dark || "";
        if (light && dark && isInertSvg(light) && isInertSvg(dark)) {
          diagrams.set(source, { light, dark });
          continue;
        }
        failures.set(
          source,
          item.error ||
            (light || dark
              ? "렌더링 결과에 스크립트나 HTML이 포함되어 사용할 수 없습니다."
              : "다이어그램을 렌더링하지 못했습니다.")
        );
      }
      scheduleIdleClose();
      return { available: true, diagrams, failures };
    } catch (error) {
      lastError = error;
      diagrams.clear();
      failures.clear();
      await disposeSession();
      // Only retry while there is budget left to do it in.
      if (deadline - Date.now() < 5_000) break;
    }
  }

  // A stall is an environment problem, not a content one, so every diagram keeps
  // the runtime renderer. Say so: otherwise the 3.4 MB library quietly reappears
  // and nobody knows why.
  if (lastError instanceof StepTimeout) {
    console.warn(`⚠ 도식 사전 렌더링을 중단했습니다: ${lastError.message}. 런타임 렌더러로 대체합니다.`);
  }
  return unavailable();
}

/** Release the cached browser (tests and long-running callers). */
export async function closeMermaidRenderer(): Promise<void> {
  await disposeSession();
}
