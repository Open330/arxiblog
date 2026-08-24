import type { LLMClient } from "../llm-client";
import { parseLlmJson } from "../utils";
import { latinTerms, retrieve } from "./retrieval";

/**
 * Source-grounded fact-check for a generated post. The transform step asks the
 * model to stay faithful, but nothing checks it against the paper afterwards.
 * This pass re-reads the passages of the source most relevant to each claim and
 * asks a second call to flag anything overstated or unsupported, then applies
 * only conservative corrections — it softens or fixes, never invents or drops.
 * It also re-grounds the [[term]] annotations against how the paper uses them.
 *
 * Best-effort by contract: any failure returns the input unchanged so it can
 * never block publishing.
 */

export interface Annotation {
  term: string;
  kind: string;
  explanation: string;
}

export interface VerifyInput {
  tldr: string;
  takeaways: string[];
  contributions: string[];
  strengths: string[];
  limitations: string[];
  annotations: Annotation[];
}

export interface VerifyOutput extends VerifyInput {
  /** How many claims/annotations were corrected. */
  changes: number;
}

/** A single claim exposed to the verifier, addressable by a stable id. */
interface Claim {
  id: string;
  text: string;
}

const CLAIM_FIELDS: Array<{ key: keyof VerifyInput; id: string }> = [
  { key: "takeaways", id: "takeaway" },
  { key: "contributions", id: "contribution" },
  { key: "strengths", id: "strength" },
  { key: "limitations", id: "limitation" },
];

function collectClaims(input: VerifyInput): Claim[] {
  const claims: Claim[] = [];
  if (input.tldr.trim()) claims.push({ id: "tldr", text: input.tldr });
  for (const { key, id } of CLAIM_FIELDS) {
    (input[key] as string[]).forEach((text, i) => {
      if (text && text.trim()) claims.push({ id: `${id}:${i}`, text });
    });
  }
  return claims;
}

export interface Verdicts {
  claims: Array<{ id: string; verdict: string; corrected?: string }>;
  annotations: Array<{ term: string; verdict: string; corrected?: string }>;
}

/** Lenient parse of the verifier's JSON reply; returns empty verdicts on failure. */
export function parseVerdicts(raw: string): Verdicts {
  const empty: Verdicts = { claims: [], annotations: [] };
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch {
    return empty;
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const asArray = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  return {
    claims: asArray(obj.claims).map((c) => ({
      id: String(c.id ?? ""),
      verdict: String(c.verdict ?? ""),
      corrected: typeof c.corrected === "string" ? c.corrected : undefined,
    })),
    annotations: asArray(obj.annotations).map((a) => ({
      term: String(a.term ?? ""),
      verdict: String(a.verdict ?? ""),
      corrected: typeof a.corrected === "string" ? a.corrected : undefined,
    })),
  };
}

const FIX = /fix|overstat|unsupport|correct|wrong|과장|틀|수정|오류/i;

/** True when a verdict calls for replacing the text with a usable correction. */
function needsFix(verdict: string, corrected: string | undefined): corrected is string {
  return FIX.test(verdict) && typeof corrected === "string" && corrected.trim().length > 0;
}

/**
 * Apply verdicts to the input — pure and defensive: unknown ids are ignored,
 * "ok" verdicts and empty corrections are no-ops, and nothing is ever removed.
 */
export function applyVerification(input: VerifyInput, verdicts: Verdicts): VerifyOutput {
  const out: VerifyOutput = {
    tldr: input.tldr,
    takeaways: [...input.takeaways],
    contributions: [...input.contributions],
    strengths: [...input.strengths],
    limitations: [...input.limitations],
    annotations: input.annotations.map((a) => ({ ...a })),
    changes: 0,
  };

  const arrayByPrefix: Record<string, string[]> = {
    takeaway: out.takeaways,
    contribution: out.contributions,
    strength: out.strengths,
    limitation: out.limitations,
  };

  for (const c of verdicts.claims) {
    if (!needsFix(c.verdict, c.corrected)) continue;
    const corrected = c.corrected.trim();
    if (c.id === "tldr") {
      if (corrected !== out.tldr) { out.tldr = corrected; out.changes++; }
      continue;
    }
    const [prefix, idxRaw] = c.id.split(":");
    const arr = arrayByPrefix[prefix];
    const idx = Number(idxRaw);
    if (arr && Number.isInteger(idx) && idx >= 0 && idx < arr.length && corrected !== arr[idx]) {
      arr[idx] = corrected;
      out.changes++;
    }
  }

  for (const a of verdicts.annotations) {
    if (!needsFix(a.verdict, a.corrected)) continue;
    const corrected = a.corrected.trim();
    const target = out.annotations.find((x) => x.term.toLowerCase() === a.term.toLowerCase());
    if (target && corrected !== target.explanation) {
      target.explanation = corrected;
      out.changes++;
    }
  }

  return out;
}

function buildPrompt(
  meta: { title: string; abstract: string },
  grounding: string,
  claims: Claim[],
  annotations: Annotation[]
): { system: string; user: string } {
  const system = `당신은 과학 팩트체커입니다. 아래 [원문 근거]만을 기준으로, 초안의 주장과 용어 설명이 원문에 부합하는지 판정합니다.

엄격한 규칙:
- 오직 [원문 근거]에 나온 내용으로만 판단합니다. 근거로 참/거짓을 확정할 수 없으면 반드시 "ok"로 둡니다(모르면 건드리지 않음).
- 명백히 원문과 다르거나(수치·결과·주체가 틀림), 원문보다 과장된 주장만 "fix"로 표시하고, corrected에 원문에 맞게 고친(과장을 덜어낸) 한국어 문장을 넣습니다.
- corrected는 원래 문장의 형식·길이를 유지하고, 원문에 없는 새 수치나 사실을 만들지 않습니다.
- 용어 설명(annotations)이 원문의 용례와 어긋나면 "fix"로 표시하고 corrected에 바로잡은 설명을 넣습니다.
- 출력은 아래 JSON 형식만. 설명·군더더기 금지.`;

  const claimsBlock = claims.map((c) => `${c.id} | ${c.text}`).join("\n");
  const annoBlock = annotations.length
    ? annotations.map((a) => `${a.term} | ${a.explanation}`).join("\n")
    : "(없음)";

  const user = `[논문] ${meta.title}
초록: ${meta.abstract}

[원문 근거]
${grounding || "(추출된 본문 없음 — 근거가 부족하면 모두 ok로 두세요)"}

[검증할 주장]  (형식: id | 문장)
${claimsBlock}

[검증할 용어 설명]  (형식: 용어 | 설명)
${annoBlock}

아래 JSON만 출력:
{
  "claims": [{ "id": "<위 id 그대로>", "verdict": "ok" | "fix", "corrected": "<verdict가 fix일 때만, 원문에 맞게 고친 문장>" }],
  "annotations": [{ "term": "<용어 그대로>", "verdict": "ok" | "fix", "corrected": "<fix일 때만 바로잡은 설명>" }]
}`;

  return { system, user };
}

export async function verifyAndGround(
  llm: LLMClient,
  meta: { title: string; abstract: string },
  rawText: string,
  input: VerifyInput
): Promise<VerifyOutput> {
  const claims = collectClaims(input);
  if (claims.length === 0 && input.annotations.length === 0) {
    return { ...input, changes: 0 };
  }

  // Ground on the passages most relevant to the claims and terms. Claims are
  // Korean, the paper English, so expand with the technical vocabulary they share.
  const terms = input.annotations.map((a) => a.term);
  const query = [...claims.map((c) => c.text), ...terms].join(" ");
  const expandTerms = latinTerms([meta.title, terms.join(" "), claims.map((c) => c.text).join(" ")]);
  const passages = rawText ? retrieve(rawText, query, { k: 8, budgetChars: 12_000, expandTerms }) : [];
  const grounding = passages
    .map((p, i) => `[근거 ${i + 1}${p.section ? " · " + p.section : ""}]\n${p.text}`)
    .join("\n\n");

  const { system, user } = buildPrompt(meta, grounding, claims, input.annotations);
  const reply = await llm.chatComplete(system, user, 1500);
  return applyVerification(input, parseVerdicts(reply));
}
