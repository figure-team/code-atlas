import { expect, test } from "vitest";
import type { EdgeKind, FileEdge } from "../domain-map/types.js";
import { STRONG_EDGE_KINDS } from "./types.js";
import { buildAdjacency, computeFanIn, reachClosure } from "./reach.js";

// T1 DoD: 역=상류·정=하류 대칭, 순환, kind 필터, 동일입력 byte 동일, depthCap.

const STRONG = new Set<EdgeKind>(STRONG_EDGE_KINDS);

function edge(source: string, target: string, kind: EdgeKind, line: number | null): FileEdge {
  return { source, target, kind, line };
}

// A → B → C  (A는 B에, B는 C에 의존; field-type 강신호)
const CHAIN: FileEdge[] = [
  edge("A.java", "B.java", "field-type", 10),
  edge("B.java", "C.java", "field-type", 20),
];

test("reverse 도달 = upstream (시드에 의존하는 호출자)", () => {
  const adj = buildAdjacency(CHAIN, STRONG, "reverse");
  const reached = reachClosure(["C.java"], adj, 12);
  expect(reached.map((r) => r.relPath)).toEqual(["A.java", "B.java"]);
  const b = reached.find((r) => r.relPath === "B.java")!;
  expect(b.minDepth).toBe(1); // B가 C에 직접 의존
  expect(b.viaKinds).toEqual(["field-type"]);
  // reverse 인용은 영향 파일 자신의 라인 (B가 C를 참조하는 곳)
  expect(b.citation).toEqual({ filePath: "B.java", line: 20 });
  const a = reached.find((r) => r.relPath === "A.java")!;
  expect(a.minDepth).toBe(2);
  expect(a.citation).toEqual({ filePath: "A.java", line: 10 });
});

test("forward 도달 = downstream (시드가 의존하는 협력자)", () => {
  const adj = buildAdjacency(CHAIN, STRONG, "forward");
  const reached = reachClosure(["A.java"], adj, 12);
  expect(reached.map((r) => r.relPath)).toEqual(["B.java", "C.java"]);
  // forward 인용은 의존이 적힌 source 라인
  const b = reached.find((r) => r.relPath === "B.java")!;
  expect(b.citation).toEqual({ filePath: "A.java", line: 10 });
});

test("시드는 영향집합에서 제외 (변경의 원점)", () => {
  const adj = buildAdjacency(CHAIN, STRONG, "reverse");
  const reached = reachClosure(["C.java"], adj, 12);
  expect(reached.find((r) => r.relPath === "C.java")).toBeUndefined();
});

test("import 약신호는 기본 필터에서 제외 (옵트인)", () => {
  const edges = [edge("X.java", "Y.java", "import", 5)];
  const adjStrong = buildAdjacency(edges, STRONG, "reverse");
  expect(reachClosure(["Y.java"], adjStrong, 12)).toEqual([]);
  // import 포함 시 도달
  const adjAll = buildAdjacency(edges, new Set<EdgeKind>([...STRONG, "import"]), "reverse");
  expect(reachClosure(["Y.java"], adjAll, 12).map((r) => r.relPath)).toEqual(["X.java"]);
});

test("순환(A↔B) — 시드 제외로 무한루프 없음, 결정론", () => {
  const cyc = [edge("A.java", "B.java", "field-type", 1), edge("B.java", "A.java", "field-type", 2)];
  const adj = buildAdjacency(cyc, STRONG, "reverse");
  const reached = reachClosure(["A.java"], adj, 12);
  expect(reached.map((r) => r.relPath)).toEqual(["B.java"]); // A는 시드라 제외
});

test("depthCap 절단", () => {
  const adj = buildAdjacency(CHAIN, STRONG, "reverse");
  const reached = reachClosure(["C.java"], adj, 1); // 1 hop만
  expect(reached.map((r) => r.relPath)).toEqual(["B.java"]); // A(2 hop)는 잘림
});

test("동일 입력 2회 → 동일 출력 (N1 결정론, byte 동일)", () => {
  const edges = [
    edge("A.java", "Z.java", "field-type", 3),
    edge("B.java", "Z.java", "ctor-param", 7),
    edge("C.java", "B.java", "extends", 1),
  ];
  const run = () => JSON.stringify(reachClosure(["Z.java"], buildAdjacency(edges, STRONG, "reverse"), 12));
  expect(run()).toBe(run());
});

test("viaKinds = 여러 선행 간선 종류의 합집합", () => {
  const edges = [
    edge("A.java", "S.java", "field-type", 5),
    edge("A.java", "S.java", "ctor-param", 9), // 같은 파일이 두 종류로 의존
  ];
  const adj = buildAdjacency(edges, STRONG, "reverse");
  const a = reachClosure(["S.java"], adj, 12).find((r) => r.relPath === "A.java")!;
  expect(a.viaKinds).toEqual(["ctor-param", "field-type"]); // 정렬됨
  expect(a.citation).toEqual({ filePath: "A.java", line: 5 }); // 가장 이른 라인
});

test("computeFanIn = target 진입차수 (hub 식별)", () => {
  const edges = [
    edge("A.java", "Hub.java", "field-type", 1),
    edge("B.java", "Hub.java", "field-type", 1),
    edge("C.java", "Hub.java", "import", 1), // import는 STRONG에서 제외
  ];
  const fanIn = computeFanIn(edges, STRONG);
  expect(fanIn.get("Hub.java")).toBe(2); // import 제외 → A,B만
});
