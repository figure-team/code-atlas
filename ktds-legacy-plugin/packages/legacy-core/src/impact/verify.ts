import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { CITATION_STATUS, type CitationStatus } from "../domain-map/verify.js";
import { ImpactCitationSchema, type ImpactCitation } from "./types.js";

// T5 — 인용 검증 (ADR-002 ID6). domain-map/verify.ts:71-132의 normalize/
// isTrivialSnippet/verifyCitation를 그대로 복제한다. 원본은 module-private이고
// 입력이 DomainFill[]에 강결합이라 import 불가 — U-A·domain-map 무수정 규율을
// 지키려 복제하고, verify.test.ts의 골든 동치 테스트(공개 verifyFills 경유)로
// 원본과 status 일치를 고정한다(복제 드리프트 방어). CitationStatus 유니온만
// 원본에서 import해(공개) 두 검증기가 같은 상태 공간을 공유하게 한다.
//
// impact 인용은 snippet이 비어 있을 수 있다(엔진이 못 읽은 파일) → normalize("")
// = "" → isTrivialSnippet 참 → "trivial-snippet"으로 자연 강등(원본 로직 그대로).

/** 공백 정규화 — 들여쓰기/연속 공백 차이는 일치로 본다 (원본 동형). */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 스니펫 효력 기준 (원본 동형): 정규화 8자 이상 + 식별자성 토큰 1개 이상. */
function isTrivialSnippet(normalized: string): boolean {
  let effective = 0;
  for (const ch of normalized) effective += /[가-힣]/.test(ch) ? 2 : 1;
  if (effective < 8) return true;
  return !/[A-Za-z_$][\w$]{2,}|[가-힣]{2,}/.test(normalized);
}

interface FileCache {
  lines: string[] | null;
  escaped?: boolean;
}

/** domain-map/verify.ts:96-132 동형 — 경로탈출/실존/라인/텍스트/trivial 검증. */
async function verifyCitation(
  projectRoot: string,
  citation: ImpactCitation,
  cache: Map<string, FileCache>,
): Promise<CitationStatus> {
  const snippet = normalize(citation.snippet ?? "");
  if (isTrivialSnippet(snippet)) return "trivial-snippet";

  const abs = path.resolve(projectRoot, citation.filePath);
  const rootAbs = path.resolve(projectRoot);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return "path-escape";

  let entry = cache.get(abs);
  if (!entry) {
    try {
      const real = await fs.realpath(abs);
      const realRoot = await fs.realpath(rootAbs);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        entry = { lines: null, escaped: true };
      } else {
        entry = { lines: (await fs.readFile(real, "utf-8")).split("\n") };
      }
    } catch {
      entry = { lines: null };
    }
    cache.set(abs, entry);
  }
  if (entry.escaped) return "path-escape";
  if (entry.lines === null) return "no-file";
  if (citation.line > entry.lines.length) return "line-out-of-range";

  const fileLine = normalize(entry.lines[citation.line - 1]);
  if (fileLine.length === 0 || !fileLine.includes(snippet)) return "text-mismatch";
  return "ok";
}

// ── impact 항목 검증 + 근거율 리포트 ─────────────────────────────────────────

export const IMPACT_VERIFY_FILENAME = "impact-verify-report.json";

export const VerifiedImpactCitationSchema = ImpactCitationSchema.extend({
  status: z.enum(CITATION_STATUS),
});

export const ImpactVerifyItemSchema = z.object({
  /** 항목 분류: 'file'|'api'|'mapper'|'flow'|'domain' 등 (리포트용). */
  kind: z.string(),
  /** 항목 식별자 (relPath/routeId/flowId 등). */
  ref: z.string(),
  text: z.string(),
  citations: z.array(VerifiedImpactCitationSchema),
  /** ok 인용 ≥1 → GROUNDED, 아니면 NEEDS_REVIEW (삭제 금지). */
  verdict: z.enum(["GROUNDED", "NEEDS_REVIEW"]),
});
export type VerifiedImpactItem = z.infer<typeof ImpactVerifyItemSchema>;

export const ImpactVerifyReportSchema = z.object({
  schemaVersion: z.literal(1),
  gitCommit: z.string().nullable(),
  items: z.array(ImpactVerifyItemSchema),
  overall: z.object({
    itemTotal: z.number().int().nonnegative(),
    itemGrounded: z.number().int().nonnegative(),
    citationTotal: z.number().int().nonnegative(),
    citationOk: z.number().int().nonnegative(),
    /** 근거율 = GROUNDED / 인용 보유 항목 (N2 — 인용 없는 항목은 분모 제외). */
    groundedPct: z.number(),
    /** 인용이 0개인 항목 수(흐름/도메인 등 INFERRED) — groundedPct 분모 투명화. */
    uncitedClaims: z.number().int().nonnegative(),
  }),
});
export type ImpactVerifyReport = z.infer<typeof ImpactVerifyReportSchema>;

/** 검증 대상 항목 (근거 인용을 가진 주장만 넘긴다 — N2는 인용 보유분 기준). */
export interface ImpactClaimItem {
  kind: string;
  ref: string;
  text: string;
  citations: ImpactCitation[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pct(num: number, den: number): number {
  return den === 0 ? 100 : Math.round((num / den) * 1000) / 10;
}

/** impact 주장들의 인용을 실파일과 대조 → per-doc 근거율 리포트 (N2). */
export async function verifyImpactClaims(
  projectRoot: string,
  items: readonly ImpactClaimItem[],
  gitCommit: string | null,
): Promise<ImpactVerifyReport> {
  const cache = new Map<string, FileCache>();
  const verified: VerifiedImpactItem[] = [];

  for (const item of [...items].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.ref, b.ref))) {
    const citations = [];
    for (const c of item.citations) {
      citations.push({ ...c, status: await verifyCitation(projectRoot, c, cache) });
    }
    verified.push({
      kind: item.kind,
      ref: item.ref,
      text: item.text,
      citations,
      verdict: citations.some((c) => c.status === "ok") ? "GROUNDED" : "NEEDS_REVIEW",
    });
  }

  const citationTotal = verified.reduce((n, i) => n + i.citations.length, 0);
  const citationOk = verified.reduce(
    (n, i) => n + i.citations.filter((c) => c.status === "ok").length,
    0,
  );
  const itemGrounded = verified.filter((i) => i.verdict === "GROUNDED").length;
  // 인용 없는 항목(흐름/도메인 등)은 GROUNDED 불가 → groundedPct 분모에서 제외
  // 하되 uncitedClaims로 노출한다(MED-4: 분모 편향 투명화).
  const citedCount = verified.filter((i) => i.citations.length > 0).length;

  return {
    schemaVersion: 1,
    gitCommit,
    items: verified,
    overall: {
      itemTotal: verified.length,
      itemGrounded,
      citationTotal,
      citationOk,
      groundedPct: pct(itemGrounded, citedCount),
      uncitedClaims: verified.length - citedCount,
    },
  };
}
