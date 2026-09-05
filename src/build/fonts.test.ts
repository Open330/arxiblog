import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { prepareFonts, readDynamicSubsetFaces, renderFontCss, type FontFace } from "./fonts";

const roots: string[] = [];
function scratch(prefix = "arxiblog-fonts-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resolveSubsetCss(): string | null {
  try {
    return Bun.resolveSync("pretendard/dist/web/static/pretendard-dynamic-subset.css", import.meta.dir);
  } catch {
    return null;
  }
}
const SUBSET_CSS = resolveSubsetCss();
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

describe("generated font stylesheet", () => {
  const faces: FontFace[] = [
    { weight: 400, url: "vendor/pretendard/subset/A.woff2", unicodeRange: "U+ac00-ac01, U+ac04", sourcePath: "/x/A.woff2" },
    { weight: 700, url: "vendor/pretendard/Pretendard-Bold.woff2", sourcePath: "/x/B.woff2" },
  ];

  test("faces stay self-hosted, swap-rendered, and keep their unicode-range", () => {
    const css = renderFontCss(faces, "dynamic-subset");
    expect(css).toContain('font-family:"Pretendard"');
    expect(css).toContain("font-display:swap");
    expect(css).toContain("font-weight:400");
    expect(css).toContain("font-weight:700");
    // Spaces between the ~6,900 range entries are stripped; the ranges are not.
    expect(css).toContain("unicode-range:U+ac00-ac01,U+ac04;");
    // A weight with no unicode-range must not emit an empty declaration.
    expect(css).not.toContain("unicode-range:;");
    expect(css).toContain("vendor/pretendard/LICENSE.txt (OFL-1.1)");
  });

  test("no face is ever loaded from a remote origin", () => {
    for (const mode of ["dynamic-subset", "full"] as const) {
      const urls = [...renderFontCss(faces, mode).matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url.startsWith("vendor/pretendard/")).toBe(true);
        expect(/^(?:[a-z]+:)?\/\//i.test(url)).toBe(false);
      }
    }
  });
});

describe("dynamic subset parsing", () => {
  test("a stylesheet that cannot be read falls back instead of throwing", () => {
    expect(readDynamicSubsetFaces(join(scratch(), "missing.css"))).toBeNull();
  });

  test("a face missing its unicode-range or its file is rejected wholesale", () => {
    const root = scratch();
    const dir = join(root, "woff2-dynamic-subset");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "A.woff2"), "x");
    const face = (weight: number, file: string, range: string | null) =>
      `@font-face{font-weight:${weight};src:url(./woff2-dynamic-subset/${file}) format('woff2');${range ? `unicode-range: ${range};` : ""}}`;

    // Missing unicode-range → null (the whole stylesheet is untrusted).
    writeFileSync(join(root, "a.css"), face(400, "A.woff2", null) + face(700, "A.woff2", "U+41"));
    expect(readDynamicSubsetFaces(join(root, "a.css"))).toBeNull();

    // Referenced file absent → null, so the CSS can never outrun the copy.
    writeFileSync(join(root, "b.css"), face(400, "A.woff2", "U+41") + face(700, "GONE.woff2", "U+41"));
    expect(readDynamicSubsetFaces(join(root, "b.css"))).toBeNull();

    // One weight split into more chunks than the other → null.
    writeFileSync(join(root, "c.css"), face(400, "A.woff2", "U+41") + face(400, "A.woff2", "U+42") + face(700, "A.woff2", "U+41"));
    expect(readDynamicSubsetFaces(join(root, "c.css"))).toBeNull();

    // Symmetric and complete → accepted, and other weights are dropped.
    writeFileSync(join(root, "d.css"), face(400, "A.woff2", "U+41") + face(700, "A.woff2", "U+41") + face(300, "A.woff2", "U+41"));
    const ok = readDynamicSubsetFaces(join(root, "d.css"));
    expect(ok).not.toBeNull();
    expect(ok!.map((f) => f.weight).sort()).toEqual([400, 700]);
  });
});

describe.if(!!SUBSET_CSS)("upstream dynamic subset", () => {
  test("both weights are split identically and every chunk file exists", () => {
    const faces = readDynamicSubsetFaces(SUBSET_CSS!)!;
    expect(faces).not.toBeNull();
    const w400 = faces.filter((f) => f.weight === 400);
    const w700 = faces.filter((f) => f.weight === 700);
    expect(w400.length).toBe(w700.length);
    expect(w400.length).toBeGreaterThan(1); // otherwise this is not a subset at all
    for (const face of faces) expect(existsSync(face.sourcePath)).toBe(true);
  });

  // The whole point of chunking over a build-time "only the glyphs this site
  // uses" subset: chat answers are produced at runtime and may contain any
  // Korean syllable, so the union must still be the complete font.
  test("the chunks together still cover every Hangul syllable", () => {
    const faces = readDynamicSubsetFaces(SUBSET_CSS!)!.filter((f) => f.weight === 400);
    const covered = new Set<number>();
    for (const face of faces) {
      for (const part of face.unicodeRange!.split(",")) {
        const m = /U\+([0-9a-f]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
        if (!m) continue;
        for (let c = parseInt(m[1], 16); c <= parseInt(m[2] || m[1], 16); c++) covered.add(c);
      }
    }
    let missing = 0;
    for (let c = HANGUL_START; c <= HANGUL_END; c++) if (!covered.has(c)) missing++;
    expect(missing).toBe(0);
    for (const ch of "AZaz0.,%") expect(covered.has(ch.codePointAt(0)!)).toBe(true);
  });

  test("a page of Korean prose pulls far less than the two full faces", () => {
    const faces = readDynamicSubsetFaces(SUBSET_CSS!)!;
    const sample = "확산 모델로 단백질 구조를 설계합니다. 트랜스포머는 어텐션만으로 문장을 이해하고, 강화학습은 보상을 따라 정책을 다듬습니다.";
    const needed = new Set<number>();
    for (const ch of sample) needed.add(ch.codePointAt(0)!);
    let bytes = 0;
    for (const face of faces) {
      const hit = face.unicodeRange!.split(",").some((part) => {
        const m = /U\+([0-9a-f]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
        if (!m) return false;
        const lo = parseInt(m[1], 16), hi = parseInt(m[2] || m[1], 16);
        for (const c of needed) if (c >= lo && c <= hi) return true;
        return false;
      });
      if (hit) bytes += statSync(face.sourcePath).size;
    }
    // The two full faces are ~1,520 KB; anything near that means the subset
    // stopped working and the build is shipping whole faces again.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(700 * 1024);
  });
});

describe("prepareFonts output", () => {
  test("writes a stylesheet whose every reference is on disk, plus the OFL text", () => {
    const staticDir = join(scratch(), "static");
    mkdirSync(staticDir, { recursive: true });
    const result = prepareFonts(staticDir);

    expect(["dynamic-subset", "full"]).toContain(result.mode);
    expect(result.fileCount).toBeGreaterThan(0);
    // OFL-1.1 requires the licence to travel with the font, subset or not.
    const license = join(staticDir, "vendor", "pretendard", "LICENSE.txt");
    expect(existsSync(license)).toBe(true);
    expect(readFileSync(license, "utf8")).toContain("SIL OPEN FONT LICENSE");

    const css = readFileSync(join(staticDir, "fonts.css"), "utf8");
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(result.fileCount);
    for (const url of urls) expect(existsSync(join(staticDir, url))).toBe(true);
    expect(result.cssBytes).toBe(Buffer.byteLength(css));
  });

  test("the run is repeatable — a rebuild produces the identical stylesheet", () => {
    const staticDir = join(scratch(), "static");
    mkdirSync(staticDir, { recursive: true });
    const first = prepareFonts(staticDir);
    const css = readFileSync(join(staticDir, "fonts.css"), "utf8");
    const second = prepareFonts(staticDir);
    expect(second).toEqual(first);
    expect(readFileSync(join(staticDir, "fonts.css"), "utf8")).toBe(css);
  });
});

describe("checked-in fallback stylesheet", () => {
  // Used verbatim if src/build/fonts.ts is not reached; it must stay a valid,
  // self-hosted two-face sheet so a stale build cannot 404 its fonts.
  test("references only the two local full faces", () => {
    const css = readFileSync(join(dirname(import.meta.path), "static", "fonts.css"), "utf8");
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(urls).toEqual([
      "vendor/pretendard/Pretendard-Regular.woff2",
      "vendor/pretendard/Pretendard-Bold.woff2",
    ]);
    expect(css).toContain("font-display: swap");
    expect(css).toContain("OFL-1.1");
  });
});
