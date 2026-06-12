import { expect, test } from "vitest";
import type { AuditEventType } from "../types.js";
import {
  DEFAULT_FAN_IN_THRESHOLD,
  DEFAULT_IMPACT_DEPTH_CAP,
  IMPACT_REPORT_FILENAME,
  ImpactOptionsSchema,
  ImpactResultSchema,
  ImpactSeedSchema,
  STRONG_EDGE_KINDS,
  type ImpactResult,
} from "./types.js";

// T0 DoD: 스키마 parse 라운드트립, 옵션 기본값(강신호-only), 무타임스탬프,
// IMPACT_ANALYZED 감사 타입 컴파일 단언.

const MINIMAL: ImpactResult = {
  schemaVersion: 1,
  gitCommit: null,
  depthCap: DEFAULT_IMPACT_DEPTH_CAP,
  edgeKinds: [...STRONG_EDGE_KINDS],
  fanInThreshold: DEFAULT_FAN_IN_THRESHOLD,
  seeds: [{ relPath: "src/A.java", origin: "path", confidence: "CONFIRMED_HUMAN" }],
  upstream: {
    files: [],
    api: [],
    persistence: { mappers: [], sqlFiles: [], tableCandidateSlots: [], kgTableCatalog: [], note: "" },
    flows: [],
    domains: [],
  },
  downstream: { files: [] },
  overEdges: { hubNodes: [], importOnlyCount: 0, crossCheckDiff: [] },
  needsReview: [],
};

test("ImpactResultSchema parse/round-trip (직렬화 결정론 전제)", () => {
  const parsed = ImpactResultSchema.parse(MINIMAL);
  expect(parsed).toEqual(MINIMAL);
  // 직렬화→재파싱 동일 (writeMapArtifact stableJson 경계)
  const reparsed = ImpactResultSchema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(reparsed).toEqual(MINIMAL);
});

test("ImpactOptionsSchema 기본값 = 강신호-only + depthCap 12 (ADR ID5)", () => {
  const opts = ImpactOptionsSchema.parse({});
  expect(opts.depthCap).toBe(12);
  expect(opts.fanInThreshold).toBe(DEFAULT_FAN_IN_THRESHOLD);
  expect(opts.edgeKinds).toEqual([...STRONG_EDGE_KINDS]);
  // import만 기본 제외 (옵트인) — 상수-only 참조 노이즈
  expect(opts.edgeKinds).not.toContain("import");
  // field-type은 포함 — 도메인 객체 의존의 지배적 신호 (jpetstore 25/81)
  expect(opts.edgeKinds).toContain("field-type");
});

test("ImpactSeedSchema origin/confidence 계약", () => {
  expect(() =>
    ImpactSeedSchema.parse({ relPath: "x", origin: "nl", confidence: "NEEDS_REVIEW" }),
  ).not.toThrow();
  expect(() =>
    ImpactSeedSchema.parse({ relPath: "x", origin: "bogus", confidence: "INFERRED" }),
  ).toThrow();
});

test("ImpactResult에 타임스탬프성 필드 없음 (N1 재실행 diff=0 전제)", () => {
  const serialized = JSON.stringify(MINIMAL);
  expect(serialized).not.toMatch(/analyzedAt|scannedAt|timestamp|generatedAt|\bnow\b/i);
});

test("IMPACT_ANALYZED가 AuditEventType 유니온에 포함 (컴파일 단언)", () => {
  const ev: AuditEventType = "IMPACT_ANALYZED";
  expect(ev).toBe("IMPACT_ANALYZED");
  expect(IMPACT_REPORT_FILENAME).toBe("impact.json");
});
