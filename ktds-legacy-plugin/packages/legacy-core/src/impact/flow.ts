import type {
  ConfirmedPlan,
  FileOwnership,
  RouteEntry,
  SkeletonReport,
} from "../domain-map/types.js";
import type { DomainImpact, FlowImpact, NeedsReviewItem } from "./types.js";

// T4 — 업무흐름/도메인 영향 (ADR-002 ID3/ID7). 영향 흐름 = seed ∪ upstream을
// 포함하는 flow. 정밀 경로는 skeleton의 엣지만으로 결정론 역추적:
//   파일 →(stepSources)→ stepId →(flow_step REVERSE)→ flowId
//        →(contains_flow REVERSE)→ domainId.
// flowId↔routeId는 'flow:'↔'route:' prefix 치환(꼬리표 보존). step 입도는
// 라우트-선언-파일 단위라(같은 컨트롤러의 모든 엔드포인트가 같은 step 파일을
// 공유) '실 호출'이 아니라 '체인 내 도달' → confidence=INFERRED 고정.
//
// graceful 결손(ID7): skeleton/confirmed=null(confirm 게이트 전)이면 throw하지
// 않고 ownership 폴백 + 도메인명 NEEDS_REVIEW. cap(STEP_DEPTH_CAP/stepCap) 절단
// 파일은 ownership(depthCap=12)로 보강 + truncatedSteps를 결손큐로 노출.

export interface FlowImpactResult {
  flows: FlowImpact[];
  domains: DomainImpact[];
  needsReview: NeedsReviewItem[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const FLOW_PREFIX = "flow:";
const ROUTE_PREFIX = "route:";
const DOMAIN_PREFIX = "domain:";

/** flowId → routeId (꼬리표 보존). batch flow는 라우트가 아니라 null. */
function flowToRoute(flowId: string): string | null {
  if (!flowId.startsWith(FLOW_PREFIX)) return null;
  const body = flowId.slice(FLOW_PREFIX.length);
  return body.startsWith("batch:") ? null : ROUTE_PREFIX + body;
}

export function computeFlowImpact(
  /** seed ∪ upstream — 변경되거나 영향받는 파일들. */
  flowImpactSet: ReadonlySet<string>,
  skeleton: SkeletonReport | null,
  ownership: readonly FileOwnership[],
  routes: readonly RouteEntry[],
  confirmed: ConfirmedPlan | null,
): FlowImpactResult {
  const ownByFile = new Map(ownership.map((o) => [o.relPath, o.owners]));
  const routeIdByFile = new Map<string, string[]>();
  for (const r of routes) {
    const list = routeIdByFile.get(r.filePath);
    if (list) list.push(r.routeId);
    else routeIdByFile.set(r.filePath, [r.routeId]);
  }
  const nameByKey = new Map((confirmed?.domains ?? []).map((d) => [d.key, d.name]));

  // flowId → { domainId, viaStepId(min), via } 누적
  const flowAcc = new Map<
    string,
    { domainId: string | null; viaStepId: string | null; via: FlowImpact["via"] }
  >();
  const needsReview: NeedsReviewItem[] = [];

  const touchFlow = (
    flowId: string,
    domainId: string | null,
    stepId: string | null,
    via: FlowImpact["via"],
  ): void => {
    const prev = flowAcc.get(flowId);
    if (!prev) {
      flowAcc.set(flowId, { domainId, viaStepId: stepId, via });
      return;
    }
    // 'step' 경로가 'ownership-fallback'보다 정보량이 많아 우선.
    if (prev.via === "ownership-fallback" && via === "step") {
      flowAcc.set(flowId, { domainId, viaStepId: stepId, via });
      return;
    }
    if (domainId && !prev.domainId) prev.domainId = domainId;
    if (stepId && (prev.viaStepId === null || stepId < prev.viaStepId)) prev.viaStepId = stepId;
  };

  const covered = new Set<string>();

  if (skeleton) {
    // 인덱스: 파일→stepId[], stepId→flowId, flowId→domainId
    const stepsByFile = new Map<string, string[]>();
    for (const s of skeleton.stepSources) {
      const list = stepsByFile.get(s.relPath);
      if (list) list.push(s.stepId);
      else stepsByFile.set(s.relPath, [s.stepId]);
    }
    const flowByStep = new Map<string, string>();
    const domainByFlow = new Map<string, string>();
    for (const e of skeleton.edges) {
      if (e.type === "flow_step") flowByStep.set(e.target, e.source);
      else if (e.type === "contains_flow") domainByFlow.set(e.target, e.source);
    }

    for (const f of flowImpactSet) {
      const steps = stepsByFile.get(f);
      if (!steps || steps.length === 0) continue;
      covered.add(f);
      for (const stepId of steps) {
        const flowId = flowByStep.get(stepId);
        if (!flowId) continue;
        touchFlow(flowId, domainByFlow.get(flowId) ?? null, stepId, "step");
      }
    }

    // cap 절단 결손큐: 잘린 파일이 영향집합에 있으면 그 flow는 영향 가능성
    // 있으나 step 미수록 (조용한 누락 금지).
    for (const t of skeleton.truncatedSteps) {
      if (t.dropped.some((d) => flowImpactSet.has(d))) {
        needsReview.push({
          ref: t.flowId,
          reason: "cap 절단 파일이 영향집합에 있음 — step 미수록(영향 가능성)",
        });
      }
    }
  } else {
    needsReview.push({
      ref: "skeleton",
      reason: "도메인 맵 미확정(confirm 전) — ownership 폴백, 도메인명 NEEDS_REVIEW",
    });
  }

  // ownership 폴백: skeleton step에 안 잡힌 영향 파일은 ownership[f].owners→
  // 그 root가 선언한 라우트→flowId. 도메인 링크 없음 → NEEDS_REVIEW.
  for (const f of flowImpactSet) {
    if (covered.has(f)) continue;
    for (const owner of ownByFile.get(f) ?? []) {
      for (const routeId of routeIdByFile.get(owner) ?? []) {
        touchFlow(FLOW_PREFIX + routeId.slice(ROUTE_PREFIX.length), null, null, "ownership-fallback");
      }
    }
  }

  // FlowImpact[] 조립
  const flows: FlowImpact[] = [...flowAcc.entries()]
    .map(([flowId, acc]) => {
      const domainKey = acc.domainId ? acc.domainId.slice(DOMAIN_PREFIX.length) : null;
      const domainName = domainKey !== null ? nameByKey.get(domainKey) ?? null : null;
      return {
        flowId,
        routeId: flowToRoute(flowId),
        domainId: acc.domainId,
        domainKey,
        domainName,
        viaStepId: acc.viaStepId,
        via: acc.via,
        confidence: "INFERRED" as const,
      };
    })
    .sort((a, b) => cmp(a.flowId, b.flowId));

  // DomainImpact[] — 영향 flow의 distinct 도메인
  const domainAcc = new Map<string, { key: string; name: string | null }>();
  for (const fl of flows) {
    if (!fl.domainId) continue;
    if (!domainAcc.has(fl.domainId)) {
      domainAcc.set(fl.domainId, { key: fl.domainKey!, name: fl.domainName });
    }
  }
  const domains: DomainImpact[] = [...domainAcc.entries()]
    .map(([domainId, d]) => ({
      domainId,
      key: d.key,
      name: d.name,
      confidence: (d.name ? "INFERRED" : "NEEDS_REVIEW") as DomainImpact["confidence"],
    }))
    .sort((a, b) => cmp(a.key, b.key));

  needsReview.sort((a, b) => cmp(a.ref, b.ref) || cmp(a.reason, b.reason));
  return { flows, domains, needsReview };
}
