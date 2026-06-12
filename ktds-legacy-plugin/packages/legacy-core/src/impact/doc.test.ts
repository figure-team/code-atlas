import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIMS_FENCE_OPEN, CONFIDENCE_TAG } from "../types.js";
import { DEFAULT_STATUS_LINE, renderMarkdown } from "../doc-generator/index.js";
import type { ImpactResult } from "./types.js";
import type { ImpactVerifyReport } from "./verify.js";
import {
  buildChangeImpact,
  CHANGE_IMPACT_FILENAME,
  IMPACT_STATUS_LINE,
  publishChangeImpact,
} from "./doc.js";

// T7 DoD: 7 섹션, CLAIMS_FENCE, 읽기전용 statusLine, confidence 태그 매핑,
// 빈 섹션 (항목 없음), 발행(registerDraft 미호출).

const RESULT: ImpactResult = {
  schemaVersion: 1,
  gitCommit: null,
  depthCap: 12,
  edgeKinds: ["field-type"],
  fanInThreshold: 24,
  seeds: [{ relPath: "src/Svc.java", origin: "path", confidence: "CONFIRMED_HUMAN" }],
  upstream: {
    files: [{ relPath: "src/Ctrl.java", viaKinds: ["field-type"], minDepth: 1, citation: { filePath: "src/Ctrl.java", line: 5 } }],
    api: [{ targetKind: "route", id: "route:GET /a", filePath: "src/Ctrl.java", line: 5, handler: "Ctrl", via: "both", confidence: "CONFIRMED_AI" }],
    persistence: {
      mappers: [{ relPath: "src/M.xml", namespace: "org.M", owners: ["src/Ctrl.java"], citation: { filePath: "src/Svc.java", line: 9 } }],
      sqlFiles: [],
      tableCandidateSlots: [{ mapperRelPath: "src/M.xml", sqlSlice: { filePath: "src/M.xml", startLine: 1, endLine: 40 } }],
      kgTableCatalog: [{ name: "ACCOUNT", filePath: "schema.sql", startLine: 1, endLine: 10 }],
      note: "SQL 도달성 밖 안내",
    },
    flows: [{ flowId: "flow:GET /a", routeId: "route:GET /a", domainId: "domain:acct", domainKey: "acct", domainName: "계정", viaStepId: "step:GET /a:src/Svc.java", via: "step", confidence: "INFERRED" }],
    domains: [{ domainId: "domain:acct", key: "acct", name: "계정", confidence: "INFERRED" }],
  },
  downstream: {
    files: [{ relPath: "src/M.xml", viaKinds: ["mapper-xml"], minDepth: 1, citation: { filePath: "src/Svc.java", line: 9 } }],
  },
  overEdges: { hubNodes: [], importOnlyCount: 0, crossCheckDiff: [] },
  needsReview: [{ ref: "src/Other.java", reason: "비-Java 시드 빈약" }],
};

const VERIFY: ImpactVerifyReport = {
  schemaVersion: 1,
  gitCommit: null,
  items: [
    { kind: "api", ref: "route:GET /a", text: "t", citations: [], verdict: "GROUNDED" },
    { kind: "upstream", ref: "src/Ctrl.java", text: "t", citations: [], verdict: "GROUNDED" },
    { kind: "mapper", ref: "src/M.xml", text: "t", citations: [], verdict: "NEEDS_REVIEW" },
  ],
  overall: { itemTotal: 3, itemGrounded: 2, citationTotal: 0, citationOk: 0, groundedPct: 66.7, uncitedClaims: 0 },
};

test("7 섹션 + CLAIMS_FENCE + 읽기전용 statusLine", () => {
  const doc = buildChangeImpact(RESULT, VERIFY);
  expect(doc.filename).toBe(CHANGE_IMPACT_FILENAME);
  expect(doc.sections.map((s) => s.heading)).toEqual([
    "변경 대상 (시드)",
    "API · 진입점 영향",
    "업무 흐름 · 도메인 영향",
    "DB · 영속성 영향",
    "연관 모듈 (상류 영향)",
    "연관 협력 (하류 의존 · 보조)",
    "검토 필요",
  ]);
  const md = renderMarkdown(doc, IMPACT_STATUS_LINE);
  expect(md).toContain(`> ${IMPACT_STATUS_LINE}`);
  expect(md).not.toContain(DEFAULT_STATUS_LINE); // 5종 DRAFT 헤더 아님 (상수 바인딩)
  expect(IMPACT_STATUS_LINE).not.toBe(DEFAULT_STATUS_LINE);
  expect(md).toContain(CLAIMS_FENCE_OPEN);
});

test("confidence 태그 매핑: api GROUNDED→[확정(AI)], mapper NEEDS_REVIEW→[확인 필요], flow→[추정]", () => {
  const md = renderMarkdown(buildChangeImpact(RESULT, VERIFY), IMPACT_STATUS_LINE);
  expect(md).toContain(`${CONFIDENCE_TAG.CONFIRMED_AI} 진입점 영향: route:GET /a`);
  expect(md).toMatch(new RegExp(`${escapeRe(CONFIDENCE_TAG.NEEDS_REVIEW)} 영속성 영향\\(매퍼\\): src/M\\.xml`));
  expect(md).toContain(`${CONFIDENCE_TAG.INFERRED} 흐름 영향: flow:GET /a`);
  // 근거 cite 형식 (5종과 동일)
  expect(md).toContain("근거: `src/Ctrl.java:5`");
});

test("빈 섹션 → (항목 없음)", () => {
  const empty: ImpactResult = {
    ...RESULT,
    upstream: { files: [], api: [], persistence: { mappers: [], sqlFiles: [], tableCandidateSlots: [], kgTableCatalog: [], note: "n" }, flows: [], domains: [] },
    downstream: { files: [] },
    needsReview: [],
  };
  const md = renderMarkdown(buildChangeImpact(empty, { ...VERIFY, items: [] }), IMPACT_STATUS_LINE);
  expect(md).toContain("_(항목 없음)_");
});

test("발행: docs/09_release/에 쓰고 경로 반환 (registerDraft 미호출 — 읽기전용)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ktds-impact-doc-"));
  try {
    const file = await publishChangeImpact(dir, buildChangeImpact(RESULT, VERIFY));
    expect(file).toBe(join(dir, "docs/09_release", CHANGE_IMPACT_FILENAME));
    const content = await readFile(file, "utf-8");
    expect(content).toContain("# 변경 영향도 분석");
    // doc-status.json이 생기지 않는다 (상태기계 밖)
    await expect(readFile(join(dir, ".spec/doc-status.json"), "utf-8")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
