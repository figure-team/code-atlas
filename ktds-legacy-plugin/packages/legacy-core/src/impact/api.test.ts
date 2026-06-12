import { expect, test } from "vitest";
import type { BatchEntry, FileOwnership, RouteEntry } from "../domain-map/types.js";
import { computeApiImpact } from "./api.js";

// T2 DoD: ownership 1차/reverse 2차 일치·불일치(diff→NEEDS_REVIEW), batch 포함,
// 시드 자신이 진입점, routeId/handler/line 라벨.

function route(routeId: string, filePath: string, line = 10, handler: string | null = "Ctrl"): RouteEntry {
  return {
    routeId, method: "GET", path: "/" + routeId, rawPath: "/" + routeId,
    kind: "api", framework: "spring", filePath, line, handler, notes: [],
  };
}
function batch(entryId: string, filePath: string): BatchEntry {
  return { entryId, trigger: "scheduled", schedule: null, filePath, line: 5, handler: "Job", notes: [] };
}
function own(relPath: string, owners: string[]): FileOwnership {
  return { relPath, status: owners.length === 1 ? "sole" : owners.length ? "shared" : "unreached", owners };
}

test("both 일치 → CONFIRMED_AI, crossCheckDiff 없음", () => {
  const seed = "Account.java";
  const ctrl = "AccountController.java";
  const { api, crossCheckDiff } = computeApiImpact(
    [seed], [ctrl], [own(seed, [ctrl])], [route("route:GET /acct", ctrl)], [],
  );
  expect(api).toHaveLength(1);
  expect(api[0].via).toBe("both");
  expect(api[0].confidence).toBe("CONFIRMED_AI");
  expect(api[0].id).toBe("route:GET /acct");
  expect(api[0].handler).toBe("Ctrl");
  expect(crossCheckDiff).toEqual([]);
});

test("ownership만 (약간선 경유) → INFERRED + crossCheckDiff ownership-only", () => {
  const seed = "Account.java";
  const ctrl = "AccountController.java";
  // ownership엔 ctrl이 있지만 reverseFiles엔 없음 (import-only로 도달 → 강필터 제외)
  const { api, crossCheckDiff } = computeApiImpact(
    [seed], [], [own(seed, [ctrl])], [route("route:GET /acct", ctrl)], [],
  );
  expect(api[0].via).toBe("ownership");
  expect(api[0].confidence).toBe("INFERRED");
  expect(crossCheckDiff).toEqual([{ id: "route:GET /acct", side: "ownership-only" }]);
});

test("reverse만 (ownership 못 봄, 이상치) → NEEDS_REVIEW + reverse-only", () => {
  const seed = "Account.java";
  const ctrl = "AccountController.java";
  const { api, crossCheckDiff } = computeApiImpact(
    [seed], [ctrl], [own(seed, [])], [route("route:GET /acct", ctrl)], [],
  );
  expect(api[0].via).toBe("reverse");
  expect(api[0].confidence).toBe("NEEDS_REVIEW");
  expect(crossCheckDiff).toEqual([{ id: "route:GET /acct", side: "reverse-only" }]);
});

test("batch 진입점 포함", () => {
  const seed = "Svc.java";
  const job = "NightJob.java";
  const { api } = computeApiImpact(
    [seed], [job], [own(seed, [job])], [], [batch("batch:NightJob.java#run", job)],
  );
  expect(api).toHaveLength(1);
  expect(api[0].targetKind).toBe("batch");
  expect(api[0].id).toBe("batch:NightJob.java#run");
});

test("시드 자신이 진입점(컨트롤러) → both", () => {
  const seed = "AccountController.java";
  // 시드가 root면 ownership[seed].owners는 자기 자신 포함 (slices: root는 자신 도달)
  const { api } = computeApiImpact(
    [seed], [], [own(seed, [seed])], [route("route:GET /acct", seed)], [],
  );
  expect(api[0].via).toBe("both"); // ownership(self) + reverseSet(seed 포함)
});

test("영향 없는 라우트는 제외", () => {
  const { api } = computeApiImpact(
    ["Account.java"], ["AccountController.java"], [own("Account.java", ["AccountController.java"])],
    [route("route:GET /other", "OtherController.java")], [],
  );
  expect(api).toEqual([]);
});

test("정렬 결정론 (targetKind, id)", () => {
  const seed = "S.java";
  const owners = ["B.java", "A.java"];
  const { api } = computeApiImpact(
    [seed], owners, [own(seed, owners)],
    [route("route:GET /b", "B.java"), route("route:GET /a", "A.java")],
    [batch("batch:A.java#run", "A.java")],
  );
  // batch < route (targetKind), 그 안에서 id 정렬
  expect(api.map((a) => a.id)).toEqual(["batch:A.java#run", "route:GET /a", "route:GET /b"]);
});
