import { z } from "zod";
import { EDGE_KINDS } from "../domain-map/types.js";

// /understand-impact Stage-19 artifact contracts (ADR-002 ID3/ID4).
// The engine output `impact.json` lives under .spec/map/ alongside the
// /understand-map artifacts it consumes (ADR D6 — U-A Phase 7 cleanup never
// touches .spec/).
//
// Determinism contract (N1 / A11, mirrors domain-map/types.ts:7-10): these
// artifacts must be byte-identical across re-runs on the same commit + same
// seeds. Therefore: no timestamps, no ordinals derived from traversal order,
// fixed key order (schema order = construction order), every array sorted by
// an explicit natural key. Host-supplied prose / table citations are NOT part
// of ImpactResult — they join only at .md publish time (doc-generator prose
// boundary, ADR ID4).

export const IMPACT_REPORT_FILENAME = "impact.json";

/** Mirrors legacy-core types.ts `Confidence` (kept as a zod-usable const here). */
export const IMPACT_CONFIDENCE = [
  "CONFIRMED_AI",
  "CONFIRMED_HUMAN",
  "INFERRED",
  "NEEDS_REVIEW",
] as const;
export const ImpactConfidenceSchema = z.enum(IMPACT_CONFIDENCE);

/**
 * Default reverse-reachability edge filter = every structural kind EXCEPT
 * `import` (ADR ID5, mustFix#3). The named noise source is `import`: a
 * constant-only `import x.Y;` is a dependency on paper but not a runtime call,
 * so it inflates the reverse impact set. `field-type` stays IN — holding a
 * field of type T is a genuine structural dependency, and on real fixtures
 * (jpetstore: field-type is 25 of 81 edges, the dominant domain-composition
 * signal) excluding it badly under-reports. Hub explosion is controlled
 * separately by fanInThreshold (overEdges), and `import` remains opt-in via
 * ImpactOptions.edgeKinds. The recall/precision harness (T9) is the instrument
 * that re-tunes this set against ground truth.
 */
export const STRONG_EDGE_KINDS = [
  "injection",
  "field-type",
  "ctor-param",
  "extends",
  "implements",
  "impl",
  "mybatis",
  "mapper-xml",
] as const;

export const DEFAULT_IMPACT_DEPTH_CAP = 12; // symmetric with slices DEFAULT_DEPTH_CAP
export const DEFAULT_FAN_IN_THRESHOLD = 24; // reverse fan-in over this → hub candidate (NEEDS_REVIEW)

export const ImpactOptionsSchema = z.object({
  depthCap: z.number().int().positive().default(DEFAULT_IMPACT_DEPTH_CAP),
  /** Edge kinds that count as impact-propagating. Default = strong-signal only. */
  edgeKinds: z.array(z.enum(EDGE_KINDS)).default([...STRONG_EDGE_KINDS]),
  fanInThreshold: z.number().int().positive().default(DEFAULT_FAN_IN_THRESHOLD),
});
export type ImpactOptions = z.infer<typeof ImpactOptionsSchema>;

// ── Seeds ────────────────────────────────────────────────────────────────────

export const SEED_ORIGINS = [
  /** Explicit --path: the user named the file (highest trust). */
  "path",
  /** host(Claude) mapped natural language → file (may be NEEDS_REVIEW). */
  "nl",
  /** Derived from a route declaration file. */
  "route",
  /** Derived from a domain/flow node. */
  "domain",
] as const;

export const ImpactSeedSchema = z.object({
  /** Project-root-relative path with forward slashes (algorithm input). */
  relPath: z.string(),
  origin: z.enum(SEED_ORIGINS),
  /** Trust in the seed itself — 'nl' origin may carry NEEDS_REVIEW. */
  confidence: ImpactConfidenceSchema,
});
export type ImpactSeed = z.infer<typeof ImpactSeedSchema>;

// ── Citation (verifiable evidence anchor) ────────────────────────────────────
// Same shape as domain-map fill.ts CitationSchema so impact/verify.ts (T5) can
// run the identical path-exists → line-range → text-match → trivial gate.

export const ImpactCitationSchema = z.object({
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  /**
   * Actual source-line text. Pure stages (reach/api/persistence/flow) emit the
   * `{filePath,line}` anchor only — `snippet` is filled by the engine (T6),
   * which does the file IO, reading the committed-state line. A citation whose
   * file the engine cannot read is published without a snippet and is demoted
   * to NEEDS_REVIEW by verify (T5). Deterministic: a line's text at a fixed
   * commit is a function of the commit (same dirty-tree caveat as census).
   */
  snippet: z.string().optional(),
});
export type ImpactCitation = z.infer<typeof ImpactCitationSchema>;

// ── Affected files (reachability closure) ────────────────────────────────────

export const AffectedFileSchema = z.object({
  relPath: z.string(),
  /** Edge kinds via which this file reaches/depends-on the seed set, sorted. */
  viaKinds: z.array(z.enum(EDGE_KINDS)),
  /** Shortest BFS distance from the nearest seed (1 = direct neighbour). */
  minDepth: z.number().int().nonnegative(),
  /** Evidence line in this file for the propagating edge, when one exists. */
  citation: ImpactCitationSchema.nullable(),
});
export type AffectedFile = z.infer<typeof AffectedFileSchema>;

// ── API / batch entry-point impact ───────────────────────────────────────────

export const API_IMPACT_VIA = ["ownership", "reverse", "both"] as const;

export const ApiImpactSchema = z.object({
  /** 'route' → id is a routeId; 'batch' → id is an entryId. */
  targetKind: z.enum(["route", "batch"]),
  id: z.string(),
  filePath: z.string(),
  line: z.number().int().positive(),
  handler: z.string().nullable(),
  /** ownership=1차(캡일관), reverse=2차 교차, both=양쪽 일치. */
  via: z.enum(API_IMPACT_VIA),
  confidence: ImpactConfidenceSchema,
});
export type ApiImpact = z.infer<typeof ApiImpactSchema>;

// ── DB / persistence impact ──────────────────────────────────────────────────

export const PersistenceMapperSchema = z.object({
  relPath: z.string(),
  /** MyBatis namespace when known (mapper XML), else null. */
  namespace: z.string().nullable(),
  /** Entry points (routes/batch roots) reaching this mapper, sorted. */
  owners: z.array(z.string()),
  citation: ImpactCitationSchema.nullable(),
});

export const PersistenceSqlFileSchema = z.object({
  relPath: z.string(),
  lang: z.string(),
});

/** Host-fill anchor: the SQL slice where host extracts table/column citations. */
export const TableCandidateSlotSchema = z.object({
  mapperRelPath: z.string(),
  sqlSlice: z.object({
    filePath: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
});

/** KG table node catalog (DDL anchor for host-extracted table names). */
export const KgTableEntrySchema = z.object({
  name: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
});
export type KgTableEntry = z.infer<typeof KgTableEntrySchema>;
export type PersistenceMapper = z.infer<typeof PersistenceMapperSchema>;
export type TableCandidateSlot = z.infer<typeof TableCandidateSlotSchema>;

export const PersistenceImpactSchema = z.object({
  mappers: z.array(PersistenceMapperSchema),
  sqlFiles: z.array(PersistenceSqlFileSchema),
  tableCandidateSlots: z.array(TableCandidateSlotSchema),
  kgTableCatalog: z.array(KgTableEntrySchema),
  /** Always-present note: SQL files are outside the reachability graph. */
  note: z.string(),
});
export type PersistenceImpact = z.infer<typeof PersistenceImpactSchema>;

// ── Flow / domain impact ─────────────────────────────────────────────────────

export const FLOW_IMPACT_VIA = ["step", "ownership-fallback"] as const;

export const FlowImpactSchema = z.object({
  flowId: z.string(),
  /** 'flow:'→'route:' prefix swap, when the flow maps to a route. */
  routeId: z.string().nullable(),
  domainId: z.string().nullable(),
  domainKey: z.string().nullable(),
  /** Confirmed display name (domain-plan.confirmed.json), else null → NEEDS_REVIEW. */
  domainName: z.string().nullable(),
  viaStepId: z.string().nullable(),
  via: z.enum(FLOW_IMPACT_VIA),
  /** step-granularity is route-declaring-file level, not real call → INFERRED. */
  confidence: ImpactConfidenceSchema,
});
export type FlowImpact = z.infer<typeof FlowImpactSchema>;

export const DomainImpactSchema = z.object({
  domainId: z.string().nullable(),
  key: z.string(),
  name: z.string().nullable(),
  confidence: ImpactConfidenceSchema,
});
export type DomainImpact = z.infer<typeof DomainImpactSchema>;

// ── Over-propagation transparency (ADR ID5) ──────────────────────────────────

export const OverEdgesSchema = z.object({
  /** Files whose reverse fan-in exceeds fanInThreshold (hub candidates). */
  hubNodes: z.array(z.object({ relPath: z.string(), fanIn: z.number().int().nonnegative() })),
  /**
   * import(약신호)로만 도달하는 "숨은" 의존 파일 수 — 강신호 기본 필터가
   * 제외한, import를 옵트인하면 추가로 보일 파일 수 (MED-2 투명성). edgeKinds에
   * import가 이미 포함되면 0(숨김 없음).
   */
  importOnlyCount: z.number().int().nonnegative(),
  /** API entries where ownership(1차) and reverse(2차) disagreed → NEEDS_REVIEW. */
  crossCheckDiff: z.array(
    z.object({ id: z.string(), side: z.enum(["ownership-only", "reverse-only"]) }),
  ),
});
export type OverEdges = z.infer<typeof OverEdgesSchema>;

export const NeedsReviewItemSchema = z.object({
  ref: z.string(),
  reason: z.string(),
});
export type NeedsReviewItem = z.infer<typeof NeedsReviewItemSchema>;

// ── Top-level report (= impact.json) ─────────────────────────────────────────

export const ImpactResultSchema = z.object({
  schemaVersion: z.literal(1),
  /** HEAD commit at the time the consumed .spec/map artifacts were produced. */
  gitCommit: z.string().nullable(),
  /** Resolved options echoed for reproducibility/transparency. */
  depthCap: z.number().int().positive(),
  edgeKinds: z.array(z.enum(EDGE_KINDS)),
  fanInThreshold: z.number().int().positive(),
  seeds: z.array(ImpactSeedSchema),
  /** Upstream = files/entries that depend on the seed (affected by the change). */
  upstream: z.object({
    files: z.array(AffectedFileSchema),
    api: z.array(ApiImpactSchema),
    persistence: PersistenceImpactSchema,
    flows: z.array(FlowImpactSchema),
    domains: z.array(DomainImpactSchema),
  }),
  /** Downstream = collaborators the seed depends on (secondary, ADR §6.2). */
  downstream: z.object({
    files: z.array(AffectedFileSchema),
  }),
  overEdges: OverEdgesSchema,
  needsReview: z.array(NeedsReviewItemSchema),
});
export type ImpactResult = z.infer<typeof ImpactResultSchema>;
