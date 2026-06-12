/**
 * ktds canonical model — the stable interface between U-A's knowledge-graph.json
 * and ktds document generation.
 *
 * Integration rule (plan §0.2 / §7 원칙3): ktds reads the on-disk
 * `.understand-anything/knowledge-graph.json` contract, NOT U-A's internal TS API.
 * The verified U-A v2.7.3 source shape this maps from is in docs/ktds/UA_BASELINE.md.
 */

// ── 근거 계약 (plan §5 / 02 §3.2) ───────────────────────────────────────
export type Confidence =
  | "CONFIRMED_AI"
  | "CONFIRMED_HUMAN"
  | "INFERRED"
  | "NEEDS_REVIEW";

/** Rendering tag per confidence (plan §5.1). */
export const CONFIDENCE_TAG: Record<Confidence, string> = {
  CONFIRMED_AI: "[확정(AI)]",
  CONFIRMED_HUMAN: "[확정(담당자)]",
  INFERRED: "[추정]",
  NEEDS_REVIEW: "[확인 필요]",
};

/**
 * 발행 .md에서 claim 불릿 영역을 표시하는 펜스 (renderMarkdown ↔ listInferredItems 계약).
 * LLM prose가 `- [추정] …` 모양의 불릿을 흉내 내도 펜스 밖이면 claim으로 취급하지
 * 않는다 — 확정/감사 대상은 doc-generator가 만든 claim 라인뿐이다.
 */
export const CLAIMS_FENCE_OPEN = "<!-- claims -->";
export const CLAIMS_FENCE_CLOSE = "<!-- /claims -->";

export interface Evidence {
  path: string;
  symbol?: string;
  line?: number;
}

export interface Claim {
  claim: string;
  confidence: Confidence;
  /** CONFIRMED_AI requires >= 1 evidence, else the doc is RETURNED (plan §5.2 / A5). */
  evidence: Evidence[];
  requires_human_review: boolean;
}

// ── Canonical graph (kg-reader output) ─────────────────────────────────
/**
 * U-A NodeType (21 total), already canonicalized by U-A schema.ts before it
 * lands on disk. Verified against v2.7.3 types.ts (docs/ktds/UA_BASELINE.md).
 */
export type CanonicalKind =
  | "file" | "function" | "class" | "module" | "concept"
  | "config" | "document" | "service" | "table" | "endpoint"
  | "pipeline" | "schema" | "resource"
  | "domain" | "flow" | "step"
  | "article" | "entity" | "topic" | "claim" | "source";

export interface CanonicalNode {
  /** Stable derived id, e.g. "LoginController#login" — NOT U-A's ordinal `id`. plan §2.1 uid 정책 */
  uid: string;
  kind: CanonicalKind;
  name: string;
  evidence?: Evidence;
  summary: string;
  tags: string[];
  /**
   * U-A domain/flow/step 노드의 domainMeta passthrough (Stage-18.1, ADR D2).
   * entities/businessRules/crossDomainInteractions + ktds 확장(ktdsClaims 인용).
   */
  domainMeta?: Record<string, unknown>;
}

export interface CanonicalEdge {
  sourceUid: string;
  targetUid: string;
  /** U-A EdgeType (35). */
  type: string;
  direction: "forward" | "backward" | "bidirectional";
  weight: number;
}

export interface ProjectMeta {
  name: string;
  languages: string[];
  frameworks: string[];
  description: string;
  gitCommitHash: string;
  /** build/config files (pom.xml, build.gradle, …) — evidence source for language/framework claims (§5.2 path-only OK). */
  configFiles: string[];
}

export interface Layer {
  id: string;
  name: string;
  description: string;
  /** member node uids (mapped from U-A raw nodeIds). */
  nodeUids: string[];
}

export interface CanonicalGraph {
  /** U-A graph data version (field name is `version`, e.g. "1.0.0"). plan §0.2 */
  sourceVersion: string;
  /** structural fingerprint for drift detection (plan §2.1 / A14). */
  fingerprint: string;
  project: ProjectMeta;
  layers: Layer[];
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
}

// ── 문서 모델 (doc-generator) — 결정론 skeleton + 선택적 LLM prose (plan §2.2) ──
export interface DocSection {
  heading: string;
  /** 근거 붙은 항목들 (모두 evidence 계약을 통과). */
  claims: Claim[];
  /** host CLI(Claude)가 생성한 산문 본문. skeleton에는 비어 있음. */
  prose?: string;
}

export interface GeneratedDoc {
  /** 파일명, 예: "01_tech-stack.md". */
  filename: string;
  title: string;
  sections: DocSection[];
}

// ── 검토/승인 상태기계 (plan §3.3 / 축③) ───────────────────────────────
export type DocState = "DRAFT" | "UNDER_REVIEW" | "APPROVED" | "RETURNED";

// ── 감사 로그 (plan §3.3 — MVP 이벤트 집합; 보안 이벤트는 Phase 2) ───────
export type AuditEventType =
  | "LLM_REQUEST"
  | "DOC_GENERATED"
  | "DOC_ITEM_CONFIRMED"
  | "DOC_APPROVED"
  | "RUN_ABORTED"
  | "INIT_RERUN"
  | "STALE_LOCK_REMOVED"
  /** /understand-map 도메인 경계 확정 (S7 게이트 — Stage-16). */
  | "MAP_PLAN_CONFIRMED"
  /** /understand-impact 변경 영향도 분석 실행 (Stage-19, ADR-002). */
  | "IMPACT_ANALYZED";

export interface AuditEvent {
  /** ISO timestamp. */
  ts: string;
  type: AuditEventType;
  /** document filename, when applicable. */
  doc?: string;
  /** operator handle/initials — NOT real name/employee id (O3, MVP 미저장). */
  by?: string;
  runId?: string;
  detail?: Record<string, unknown>;
}

// ── 승인 기록 (plan §7.2 — approvals.json) ──────────────────────────────
export interface ApprovalRecord {
  doc: string;
  /** handle/initials only (O3). */
  by: string;
  at: string;
  /** 미확정 항목([확정(담당자)] 아닌 claim)이 남은 채 --force로 강제 승인된 경우 true. */
  forced?: boolean;
}
