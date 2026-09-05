import { afterAll, describe, expect, test } from "bun:test";
import { closeMermaidRenderer, mermaidPrerenderEnabled, prerenderMermaid } from "./mermaid";

const FLOWCHART = "flowchart TD\n  A[시작 지점] --> B{판단}";
const SEQUENCE = "sequenceDiagram\n  A->>B: hello";
const BROKEN = "flowchart TD\n  D[판별자: 경찰] <-- I";

const viewBox = (svg: string): string => (svg.match(/viewBox="([^"]+)"/) || ["", ""])[1];
const svgId = (svg: string): string => (svg.match(/<svg[^>]*\bid="([^"]+)"/) || ["", ""])[1];

afterAll(async () => {
  // Never leave a browser behind for the rest of the suite (or the machine).
  await closeMermaidRenderer();
});

describe("mermaid pre-render", () => {
  test("renders both colour schemes with identical geometry", async () => {
    const result = await prerenderMermaid([FLOWCHART, SEQUENCE]);
    expect(result.available).toBe(true);
    expect(result.diagrams.size).toBe(2);
    const diagram = result.diagrams.get(FLOWCHART)!;
    expect(diagram.light.startsWith("<svg")).toBe(true);
    expect(diagram.dark.startsWith("<svg")).toBe(true);
    // One pan/zoom viewport fits both only while they lay out identically.
    expect(viewBox(diagram.light)).toBe(viewBox(diagram.dark));
    expect(diagram.light).not.toBe(diagram.dark); // different theme colours
    // The SVG bypasses the Markdown sanitizer, so it must be inert.
    expect(diagram.light).not.toMatch(/<script|<foreignObject|javascript:|\son[a-z]+\s*=/i);
  }, 60_000);

  test("a source mermaid rejects is a failure, not a missing diagram", async () => {
    const result = await prerenderMermaid([FLOWCHART, BROKEN]);
    // `available` stays true: the pass ran, so a missing diagram is a content
    // problem and must not drag the 3.4 MB runtime library back in.
    expect(result.available).toBe(true);
    expect(result.diagrams.has(FLOWCHART)).toBe(true);
    expect(result.diagrams.has(BROKEN)).toBe(false);
    expect(result.failures.get(BROKEN)).toContain("Parse error");
  }, 60_000);

  /**
   * The regression this file exists for. Preparing a render page costs ~2 s,
   * almost all of it decoding the 750 KB Korean face, and that decode contends
   * across concurrent Chromium instances (measured 2.0 s at 1x, 10.9 s at 6x).
   * Paying it per call is what let a busy machine push a build past its
   * timeouts. Repeat calls must reuse the prepared page instead.
   */
  test("repeated calls reuse the prepared page and stay correct", async () => {
    await closeMermaidRenderer(); // start from a known-cold state
    const first = await prerenderMermaid([FLOWCHART]);
    expect(first.available).toBe(true);
    const firstSvg = first.diagrams.get(FLOWCHART)!.light;

    const ids = new Set<string>([svgId(firstSvg)]);
    const started = Date.now();
    for (let index = 0; index < 6; index += 1) {
      const repeat = await prerenderMermaid([FLOWCHART]);
      expect(repeat.available).toBe(true);
      const svg = repeat.diagrams.get(FLOWCHART)!.light;
      // Same layout every time — a reused page must not drift.
      expect(viewBox(svg)).toBe(viewBox(firstSvg));
      // …but a fresh id, or the previous SVG's scoped CSS would collide with it.
      ids.add(svgId(svg));
    }
    expect(ids.size).toBe(7);
    // Six warm renders cost milliseconds each; a cold browser per call would be
    // ~2.4 s each. The bound is loose enough for a loaded CI box, and still an
    // order of magnitude below "prepared a page every time".
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 90_000);

  test("closing the renderer releases the page and the next call rebuilds it", async () => {
    await prerenderMermaid([FLOWCHART]);
    await closeMermaidRenderer();
    const afterClose = await prerenderMermaid([FLOWCHART]);
    expect(afterClose.available).toBe(true);
    expect(afterClose.diagrams.size).toBe(1);
  }, 60_000);

  test("an exhausted budget degrades to unavailable instead of hanging", async () => {
    await closeMermaidRenderer();
    const previous = process.env.ARXIBLOG_MERMAID_TIMEOUT_MS;
    process.env.ARXIBLOG_MERMAID_TIMEOUT_MS = "1";
    const started = Date.now();
    try {
      const result = await prerenderMermaid([FLOWCHART]);
      // Running out of time says nothing about the diagram itself, so the caller
      // must keep the runtime renderer rather than write the content off.
      expect(result.available).toBe(false);
      expect(result.diagrams.size).toBe(0);
      expect(result.failures.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ARXIBLOG_MERMAID_TIMEOUT_MS;
      else process.env.ARXIBLOG_MERMAID_TIMEOUT_MS = previous;
    }
    expect(Date.now() - started).toBeLessThan(45_000);
    // A stalled attempt must not poison the next one.
    const recovered = await prerenderMermaid([FLOWCHART]);
    expect(recovered.available).toBe(true);
    expect(recovered.diagrams.size).toBe(1);
  }, 90_000);

  test("no sources means no browser work", async () => {
    const result = await prerenderMermaid([]);
    expect(result.available).toBe(true);
    expect(result.diagrams.size).toBe(0);
  });

  test("ARXIBLOG_MERMAID_PRERENDER gates the pass", () => {
    const previous = process.env.ARXIBLOG_MERMAID_PRERENDER;
    try {
      delete process.env.ARXIBLOG_MERMAID_PRERENDER;
      expect(mermaidPrerenderEnabled()).toBe(true);
      process.env.ARXIBLOG_MERMAID_PRERENDER = "0";
      expect(mermaidPrerenderEnabled()).toBe(false);
      process.env.ARXIBLOG_MERMAID_PRERENDER = "false";
      expect(mermaidPrerenderEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ARXIBLOG_MERMAID_PRERENDER;
      else process.env.ARXIBLOG_MERMAID_PRERENDER = previous;
    }
  });
});
