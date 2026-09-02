import { describe, expect, test } from "bun:test";
import { applyVerification, parseVerdicts, type VerifyInput } from "./verify";

function baseInput(): VerifyInput {
  return {
    tldr: "이 모델은 정확도를 99% 달성했습니다.",
    takeaways: ["속도가 10배 빨라졌다.", "메모리를 절반으로 줄였다."],
    contributions: ["새로운 옵티마이저를 제안한다."],
    strengths: ["구현이 간단하다."],
    limitations: ["대규모 실험은 없다."],
    annotations: [
      { term: "Hessian", kind: "concept", explanation: "1차 미분 행렬." },
      { term: "Adam", kind: "concept", explanation: "옵티마이저의 한 종류." },
    ],
  };
}

describe("parseVerdicts", () => {
  test("parses well-formed JSON", () => {
    const v = parseVerdicts('{"claims":[{"id":"tldr","verdict":"fix","corrected":"정확도 82%."}],"annotations":[]}');
    expect(v.claims).toHaveLength(1);
    expect(v.claims[0]).toEqual({ id: "tldr", verdict: "fix", corrected: "정확도 82%." });
  });

  test("tolerates code fences and surrounding prose", () => {
    const v = parseVerdicts('여기 결과입니다:\n```json\n{"claims":[],"annotations":[{"term":"Hessian","verdict":"fix","corrected":"2차 미분 행렬."}]}\n```');
    expect(v.annotations[0].corrected).toBe("2차 미분 행렬.");
  });

  test("returns empty verdicts on unparseable input", () => {
    expect(parseVerdicts("not json at all")).toEqual({ claims: [], annotations: [] });
    expect(parseVerdicts("")).toEqual({ claims: [], annotations: [] });
  });
});

describe("applyVerification", () => {
  test("applies a tldr correction and counts it", () => {
    const out = applyVerification(baseInput(), {
      claims: [{ id: "tldr", verdict: "fix", corrected: "이 모델은 정확도 82%를 달성했습니다." }],
      annotations: [],
    });
    expect(out.tldr).toBe("이 모델은 정확도 82%를 달성했습니다.");
    expect(out.changes).toBe(1);
  });

  test("records a reader-facing report: checked count + before/after adjustments", () => {
    const input = baseInput();
    const out = applyVerification(input, {
      claims: [{ id: "tldr", verdict: "fix", corrected: "이 모델은 정확도 82%를 달성했습니다." }],
      annotations: [{ term: "Hessian", verdict: "fix", corrected: "2차 미분(곡률) 행렬." }],
    });
    // Every claim + annotation is counted as checked, not just the fixed ones.
    const claimCount = 1 + input.takeaways.length + input.contributions.length + input.strengths.length + input.limitations.length;
    expect(out.report.checked).toBe(claimCount + input.annotations.length);
    expect(out.report.adjustments).toEqual([
      { label: "핵심 요약", before: input.tldr, after: "이 모델은 정확도 82%를 달성했습니다." },
      { label: "용어 설명: Hessian", before: "1차 미분 행렬.", after: "2차 미분(곡률) 행렬." },
    ]);
    expect(out.changes).toBe(out.report.adjustments.length);
  });

  test("a meta-disclaimer that is skipped never appears in the report", () => {
    const out = applyVerification(baseInput(), {
      claims: [],
      annotations: [{ term: "Hessian", verdict: "fix", corrected: "제시된 원문 근거에는 정의가 없습니다." }],
    });
    expect(out.report.adjustments).toEqual([]);
    expect(out.report.checked).toBeGreaterThan(0);
  });

  test("fixes an indexed array claim", () => {
    const out = applyVerification(baseInput(), {
      claims: [{ id: "takeaway:0", verdict: "overstated", corrected: "속도가 2배 빨라졌다." }],
      annotations: [],
    });
    expect(out.takeaways[0]).toBe("속도가 2배 빨라졌다.");
    expect(out.takeaways[1]).toBe("메모리를 절반으로 줄였다."); // untouched
    expect(out.changes).toBe(1);
  });

  test("re-grounds an annotation by term (case-insensitive)", () => {
    const out = applyVerification(baseInput(), {
      claims: [],
      annotations: [{ term: "hessian", verdict: "fix", corrected: "2차 미분(곡률) 행렬." }],
    });
    expect(out.annotations.find((a) => a.term === "Hessian")!.explanation).toBe("2차 미분(곡률) 행렬.");
    expect(out.changes).toBe(1);
  });

  test("ok verdicts, empty corrections, and unknown ids are no-ops", () => {
    const input = baseInput();
    const out = applyVerification(input, {
      claims: [
        { id: "tldr", verdict: "ok" },
        { id: "takeaway:0", verdict: "fix", corrected: "   " }, // empty after trim
        { id: "takeaway:9", verdict: "fix", corrected: "out of range" }, // bad index
        { id: "mystery:0", verdict: "fix", corrected: "unknown prefix" },
      ],
      annotations: [{ term: "Nonexistent", verdict: "fix", corrected: "x" }],
    });
    expect(out.changes).toBe(0);
    expect(out).toMatchObject({ tldr: input.tldr, takeaways: input.takeaways });
  });

  test("rejects annotation corrections that are meta-disclaimers, not definitions", () => {
    const out = applyVerification(baseInput(), {
      claims: [],
      annotations: [
        { term: "Hessian", verdict: "fix", corrected: "제시된 원문 근거에는 해당 용어의 정의가 포함되어 있지 않습니다." },
        { term: "Adam", verdict: "fix", corrected: "적응적 학습률을 쓰는 옵티마이저." }, // a real definition — allowed
      ],
    });
    // the disclaimer is skipped, the genuine definition is applied
    expect(out.annotations.find((a) => a.term === "Hessian")!.explanation).toBe("1차 미분 행렬.");
    expect(out.annotations.find((a) => a.term === "Adam")!.explanation).toBe("적응적 학습률을 쓰는 옵티마이저.");
    expect(out.changes).toBe(1);
  });

  test("never mutates the input object", () => {
    const input = baseInput();
    applyVerification(input, { claims: [{ id: "tldr", verdict: "fix", corrected: "changed" }], annotations: [] });
    expect(input.tldr).toBe("이 모델은 정확도를 99% 달성했습니다.");
  });
});
