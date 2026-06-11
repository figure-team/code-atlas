import { expect, test } from "vitest";
import { buildSlices, DEFAULT_DEPTH_CAP } from "./slices.js";
import {
  SlicesReportSchema,
  type BatchEntry,
  type CensusReport,
  type EdgesReport,
  type FileEdge,
  type RouteEntry,
  type RoutesReport,
} from "./types.js";

// 15.3 도달성 슬라이서 단위 테스트 — BFS/depth cap/소유권 분류/결정론.

function census(...relPaths: string[]): CensusReport {
  return {
    schemaVersion: 1,
    gitCommit: null,
    fileCount: relPaths.length,
    files: relPaths.map((relPath) => ({ relPath, lang: "java" })),
    kgCrossCheck: null,
  };
}

function route(filePath: string, routeId: string): RouteEntry {
  return {
    routeId,
    method: "GET",
    path: "/x",
    rawPath: "/x",
    kind: "page",
    framework: "spring",
    filePath,
    line: 1,
    handler: null,
    notes: [],
  };
}

function batch(filePath: string, entryId: string): BatchEntry {
  return {
    entryId,
    trigger: "main",
    schedule: null,
    filePath,
    line: 1,
    handler: null,
    notes: [],
  };
}

function routesReport(routes: RouteEntry[], batchEntries: BatchEntry[] = []): RoutesReport {
  return { schemaVersion: 1, gitCommit: null, contextPath: null, routes, batchEntries };
}

function edgesReport(...triples: Array<[string, string]>): EdgesReport {
  const edges: FileEdge[] = triples.map(([source, target]) => ({
    source,
    target,
    kind: "import",
    line: 1,
  }));
  return { schemaVersion: 1, gitCommit: null, edges, unresolved: [] };
}

test("BFS 도달: root 포함, 간선 따라 전이적 도달, 결과 정렬", () => {
  const report = buildSlices(
    census("A.java", "B.java", "C.java", "D.java"),
    routesReport([route("A.java", "route:GET /a")]),
    edgesReport(["A.java", "B.java"], ["B.java", "C.java"]),
  );
  expect(report.slices).toEqual([
    {
      root: "A.java",
      entryIds: ["route:GET /a"],
      reached: ["A.java", "B.java", "C.java"],
    },
  ]);
  expect(report.depthCap).toBe(DEFAULT_DEPTH_CAP);
  expect(() => SlicesReportSchema.parse(report)).not.toThrow();
});

test("depth cap: cap 밖 파일은 도달하지 않는다", () => {
  const report = buildSlices(
    census("A.java", "B.java", "C.java"),
    routesReport([route("A.java", "route:GET /a")]),
    edgesReport(["A.java", "B.java"], ["B.java", "C.java"]),
    1,
  );
  expect(report.slices[0].reached).toEqual(["A.java", "B.java"]);
  expect(report.depthCap).toBe(1);
});

test("순환 그래프에서 종료한다 (A→B→A)", () => {
  const report = buildSlices(
    census("A.java", "B.java"),
    routesReport([route("A.java", "route:GET /a")]),
    edgesReport(["A.java", "B.java"], ["B.java", "A.java"]),
  );
  expect(report.slices[0].reached).toEqual(["A.java", "B.java"]);
});

test("소유권: 단독=sole, 다중=shared, 미도달=unreached(미해소 큐)", () => {
  const report = buildSlices(
    census("A.java", "B.java", "Common.java", "OnlyA.java", "Orphan.java"),
    routesReport([route("A.java", "route:GET /a"), route("B.java", "route:GET /b")]),
    edgesReport(
      ["A.java", "Common.java"],
      ["A.java", "OnlyA.java"],
      ["B.java", "Common.java"],
    ),
  );
  const byPath = Object.fromEntries(report.ownership.map((o) => [o.relPath, o]));
  expect(byPath["OnlyA.java"]).toEqual({
    relPath: "OnlyA.java",
    status: "sole",
    owners: ["A.java"],
  });
  expect(byPath["Common.java"]).toEqual({
    relPath: "Common.java",
    status: "shared",
    owners: ["A.java", "B.java"],
  });
  expect(byPath["Orphan.java"]).toEqual({
    relPath: "Orphan.java",
    status: "unreached",
    owners: [],
  });
  // root 자신도 sole 소유
  expect(byPath["A.java"].status).toBe("sole");
});

test("entryIds: 같은 파일의 route+batch 자연키가 정렬되어 묶인다", () => {
  const report = buildSlices(
    census("A.java"),
    routesReport(
      [route("A.java", "route:POST /a"), route("A.java", "route:GET /a")],
      [batch("A.java", "batch:A.java#main")],
    ),
    edgesReport(),
  );
  expect(report.slices[0].entryIds).toEqual([
    "batch:A.java#main",
    "route:GET /a",
    "route:POST /a",
  ]);
});

test("결정론: 간선 입력 순서가 출력에 새지 않는다", () => {
  const c = census("A.java", "B.java", "C.java");
  const r = routesReport([route("A.java", "route:GET /a")]);
  const forward = edgesReport(["A.java", "B.java"], ["A.java", "C.java"]);
  const reversed = edgesReport(["A.java", "C.java"], ["A.java", "B.java"]);
  expect(JSON.stringify(buildSlices(c, r, forward))).toBe(
    JSON.stringify(buildSlices(c, r, reversed)),
  );
});
