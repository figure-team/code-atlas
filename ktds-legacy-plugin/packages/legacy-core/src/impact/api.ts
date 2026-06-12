import type { BatchEntry, FileOwnership, RouteEntry } from "../domain-map/types.js";
import type { ApiImpact } from "./types.js";

// T2 — API/배치 진입점 영향 (ADR-002 ID3). 2단 계산으로 정확도와 교차검증을
// 동시에 얻는다:
//   1차 ownership: slices.ownership[seed].owners = 시드에 도달하는 root(진입점
//     선언 파일). depthCap=12·전 간선종류로 계산된 캡일관 인덱스(재사용 보석).
//   2차 reverse:  reach(T1)의 upstream 파일집합 ∩ {route/batch 선언 파일}.
//     강신호 필터(import 제외)라 1차의 부분집합에 가깝다.
// 두 신호가 일치(both)하면 CONFIRMED_AI, ownership만이면 INFERRED(약간선 경유
// 가능), reverse만이면 NEEDS_REVIEW(확립된 ownership이 못 본 이상치). 불일치는
// crossCheckDiff로 표면화한다(mustFix#4: 역방향 hub 위양성 은폐 방지).

export interface ApiImpactResult {
  api: ApiImpact[];
  crossCheckDiff: Array<{ id: string; side: "ownership-only" | "reverse-only" }>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeApiImpact(
  seeds: readonly string[],
  /** reach(T1) upstream의 relPath 목록 (시드 제외). */
  reverseFiles: readonly string[],
  ownership: readonly FileOwnership[],
  routes: readonly RouteEntry[],
  batchEntries: readonly BatchEntry[],
): ApiImpactResult {
  const ownByFile = new Map(ownership.map((o) => [o.relPath, o.owners]));

  // 1차: 시드들에 도달하는 모든 root(진입점 선언 파일).
  const ownershipRoots = new Set<string>();
  for (const seed of seeds) {
    for (const owner of ownByFile.get(seed) ?? []) ownershipRoots.add(owner);
  }
  // 2차: 시드 자신 + 역방향 영향 파일 (시드가 곧 진입점일 수 있으므로 포함).
  const reverseSet = new Set<string>([...seeds, ...reverseFiles]);

  const api: ApiImpact[] = [];
  const crossCheckDiff: ApiImpactResult["crossCheckDiff"] = [];

  const classify = (
    filePath: string,
  ): { via: ApiImpact["via"]; confidence: ApiImpact["confidence"] } | null => {
    const ownHit = ownershipRoots.has(filePath);
    const revHit = reverseSet.has(filePath);
    if (ownHit && revHit) return { via: "both", confidence: "CONFIRMED_AI" };
    if (ownHit) return { via: "ownership", confidence: "INFERRED" };
    if (revHit) return { via: "reverse", confidence: "NEEDS_REVIEW" };
    return null;
  };

  for (const route of routes) {
    const c = classify(route.filePath);
    if (!c) continue;
    api.push({
      targetKind: "route",
      id: route.routeId,
      filePath: route.filePath,
      line: route.line,
      handler: route.handler,
      via: c.via,
      confidence: c.confidence,
    });
    if (c.via !== "both") {
      crossCheckDiff.push({
        id: route.routeId,
        side: c.via === "ownership" ? "ownership-only" : "reverse-only",
      });
    }
  }

  for (const batch of batchEntries) {
    const c = classify(batch.filePath);
    if (!c) continue;
    api.push({
      targetKind: "batch",
      id: batch.entryId,
      filePath: batch.filePath,
      line: batch.line,
      handler: batch.handler,
      via: c.via,
      confidence: c.confidence,
    });
    if (c.via !== "both") {
      crossCheckDiff.push({
        id: batch.entryId,
        side: c.via === "ownership" ? "ownership-only" : "reverse-only",
      });
    }
  }

  api.sort((a, b) => cmp(a.targetKind, b.targetKind) || cmp(a.id, b.id));
  crossCheckDiff.sort((a, b) => cmp(a.id, b.id) || cmp(a.side, b.side));
  return { api, crossCheckDiff };
}
