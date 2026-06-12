import { expect, test } from "vitest";
import type {
  ConfirmedPlan,
  FileOwnership,
  RouteEntry,
  SkeletonReport,
  UaGraphEdge,
} from "../domain-map/types.js";
import { computeFlowImpact } from "./flow.js";

// T4 DoD: file→step→flow→domain 역추적, 꼬리표 보존 조인, skeleton 부재 graceful,
// cap 결손큐, 도메인명 NEEDS_REVIEW, via step 우선.

function skel(
  stepSources: SkeletonReport["stepSources"],
  edges: UaGraphEdge[],
  truncatedSteps: SkeletonReport["truncatedSteps"] = [],
): SkeletonReport {
  return { schemaVersion: 1, gitCommit: null, stepCap: 8, nodes: [], edges, stepSources, truncatedSteps };
}
function fstep(flowId: string, stepId: string): UaGraphEdge {
  return { source: flowId, target: stepId, type: "flow_step", direction: "forward", weight: 0.5 };
}
function cflow(domainId: string, flowId: string): UaGraphEdge {
  return { source: domainId, target: flowId, type: "contains_flow", direction: "forward", weight: 1 };
}
function route(routeId: string, filePath: string): RouteEntry {
  return {
    routeId, method: "GET", path: "/x", rawPath: "/x", kind: "api",
    framework: "spring", filePath, line: 10, handler: "Ctrl", notes: [],
  };
}
function confirmedWith(key: string, name: string): ConfirmedPlan {
  return { schemaVersion: 1, gitCommit: null, decidedBy: "t", domains: [{ key, name, roots: [], aliasKeys: [] }], excludedKeys: [] };
}

test("정밀 경로: file→step→flow→domain (엣지만 역추적)", () => {
  const s = skel(
    [{ stepId: "step:GET /a:Svc.java", relPath: "Svc.java", line: 5, className: "Svc" }],
    [cflow("domain:account", "flow:GET /a"), fstep("flow:GET /a", "step:GET /a:Svc.java")],
  );
  const r = computeFlowImpact(new Set(["Svc.java"]), s, [], [], confirmedWith("account", "계정"));
  expect(r.flows).toEqual([
    {
      flowId: "flow:GET /a", routeId: "route:GET /a", domainId: "domain:account",
      domainKey: "account", domainName: "계정", viaStepId: "step:GET /a:Svc.java",
      via: "step", confidence: "INFERRED",
    },
  ]);
  expect(r.domains).toEqual([
    { domainId: "domain:account", key: "account", name: "계정", confidence: "INFERRED" },
  ]);
});

test("flowId↔routeId 충돌 꼬리표 보존", () => {
  const s = skel(
    [{ stepId: "step:GET /a@src/A.java:Svc.java", relPath: "Svc.java", line: 1, className: null }],
    [fstep("flow:GET /a@src/A.java", "step:GET /a@src/A.java:Svc.java")],
  );
  const r = computeFlowImpact(new Set(["Svc.java"]), s, [], [], null);
  expect(r.flows[0].flowId).toBe("flow:GET /a@src/A.java");
  expect(r.flows[0].routeId).toBe("route:GET /a@src/A.java"); // 꼬리표 그대로
});

test("batch flow → routeId null", () => {
  const s = skel(
    [{ stepId: "step:batch:Job.java#run:Svc.java", relPath: "Svc.java", line: 1, className: null }],
    [fstep("flow:batch:Job.java#run", "step:batch:Job.java#run:Svc.java")],
  );
  const r = computeFlowImpact(new Set(["Svc.java"]), s, [], [], null);
  expect(r.flows[0].routeId).toBeNull();
});

test("skeleton=null → ownership 폴백 + skeleton needsReview (throw 금지, ID7)", () => {
  const ownership: FileOwnership[] = [{ relPath: "Svc.java", status: "sole", owners: ["Ctrl.java"] }];
  const r = computeFlowImpact(
    new Set(["Svc.java"]), null, ownership, [route("route:GET /a", "Ctrl.java")], null,
  );
  expect(r.flows).toEqual([
    {
      flowId: "flow:GET /a", routeId: "route:GET /a", domainId: null, domainKey: null,
      domainName: null, viaStepId: null, via: "ownership-fallback", confidence: "INFERRED",
    },
  ]);
  expect(r.domains).toEqual([]); // 도메인 링크 없음
  expect(r.needsReview.some((n) => n.ref === "skeleton")).toBe(true);
});

test("cap 절단 파일이 영향집합에 있으면 needsReview 결손큐", () => {
  const s = skel(
    [{ stepId: "step:GET /a:Svc.java", relPath: "Svc.java", line: 1, className: null }],
    [fstep("flow:GET /a", "step:GET /a:Svc.java")],
    [{ flowId: "flow:GET /a", dropped: ["Deep.java"] }],
  );
  const r = computeFlowImpact(new Set(["Svc.java", "Deep.java"]), s, [], [], null);
  expect(r.needsReview.some((n) => n.ref === "flow:GET /a")).toBe(true);
});

test("도메인명 미상(confirmed null) → 도메인 confidence NEEDS_REVIEW", () => {
  const s = skel(
    [{ stepId: "step:GET /a:Svc.java", relPath: "Svc.java", line: 1, className: null }],
    [cflow("domain:account", "flow:GET /a"), fstep("flow:GET /a", "step:GET /a:Svc.java")],
  );
  const r = computeFlowImpact(new Set(["Svc.java"]), s, [], [], null);
  expect(r.flows[0].domainName).toBeNull();
  expect(r.domains[0].confidence).toBe("NEEDS_REVIEW");
});

test("같은 flow가 step과 ownership 둘 다로 닿으면 via=step 우선", () => {
  const s = skel(
    [{ stepId: "step:GET /a:Svc.java", relPath: "Svc.java", line: 1, className: null }],
    [fstep("flow:GET /a", "step:GET /a:Svc.java")],
  );
  // Svc.java는 step으로 커버됨 → ownership 폴백 미적용
  const r = computeFlowImpact(
    new Set(["Svc.java"]), s,
    [{ relPath: "Svc.java", status: "sole", owners: ["Ctrl.java"] }],
    [route("route:GET /a", "Ctrl.java")], null,
  );
  expect(r.flows).toHaveLength(1);
  expect(r.flows[0].via).toBe("step");
});
