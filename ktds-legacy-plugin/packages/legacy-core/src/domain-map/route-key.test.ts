import { describe, expect, test } from "vitest";
import {
  assignRouteIds,
  batchEntryId,
  normalizePath,
  routeNaturalKey,
  sortRoutes,
} from "./route-key.js";
import type { RouteEntry } from "./types.js";

// 14.5 DoD: 자연키 결정론 — ordinal 금지(A15), 충돌 한정자는 선언 위치 사실에서만 파생.

function route(
  method: RouteEntry["method"],
  path: string,
  filePath: string,
  line = 1,
): Omit<RouteEntry, "routeId"> {
  return {
    method,
    path,
    rawPath: path,
    kind: "form",
    framework: "spring",
    filePath,
    line,
    handler: null,
    notes: [],
  };
}

describe("normalizePath", () => {
  test("정규화 규칙", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("a/b")).toBe("/a/b");
    expect(normalizePath("//x//y/")).toBe("/x/y");
    expect(normalizePath("/orders/")).toBe("/orders");
    expect(normalizePath("/p/{id}")).toBe("/p/{id}");
  });
});

describe("assignRouteIds", () => {
  test("유일 키는 한정자 없음", () => {
    const out = assignRouteIds([route("GET", "/a", "A.java")]);
    expect(out[0].routeId).toBe("route:GET /a");
  });

  test("파일 간 충돌 → 양쪽 모두 @filePath 한정", () => {
    const out = assignRouteIds([
      route("GET", "/dup", "b/B.java"),
      route("GET", "/dup", "a/A.java"),
    ]);
    expect(out.map((r) => r.routeId)).toEqual([
      "route:GET /dup@a/A.java",
      "route:GET /dup@b/B.java",
    ]);
  });

  test("동일 파일 내 충돌 → @filePath:line 한정", () => {
    const out = assignRouteIds([
      route("GET", "/dup", "A.java", 10),
      route("GET", "/dup", "A.java", 20),
    ]);
    expect(out.map((r) => r.routeId)).toEqual([
      "route:GET /dup@A.java:10",
      "route:GET /dup@A.java:20",
    ]);
  });

  test("입력 순서와 무관하게 동일한 ID 집합 (결정론)", () => {
    const routes = [
      route("GET", "/x", "A.java"),
      route("POST", "/x", "A.java"),
      route("GET", "/dup", "B.java"),
      route("GET", "/dup", "C.java"),
    ];
    const forward = assignRouteIds(routes);
    const reversed = assignRouteIds([...routes].reverse());
    expect(forward).toEqual(reversed);
  });

  test("메서드가 다르면 충돌 아님", () => {
    const out = assignRouteIds([
      route("GET", "/x", "A.java"),
      route("POST", "/x", "B.java"),
    ]);
    expect(out.map((r) => r.routeId)).toEqual(["route:GET /x", "route:POST /x"]);
  });

  test("동일 선언 지점(같은 파일·라인) 충돌 → 병합 + also-declared-as 노트 (routeId 유일성)", () => {
    // @GetMapping({"/list", "/list/"}) — 정규화 후 같은 path, 같은 어노테이션 라인
    const a = { ...route("GET", "/list", "C.java", 10), rawPath: "/list" };
    const b = { ...route("GET", "/list", "C.java", 10), rawPath: "/list/" };
    const out = assignRouteIds([b, a]); // 입력 순서 무관
    expect(out).toHaveLength(1);
    expect(out[0].routeId).toBe("route:GET /list");
    expect(out[0].rawPath).toBe("/list"); // 사전순 대표
    expect(out[0].notes).toEqual(["also-declared-as:/list/"]);
  });

  test("동일 선언 지점의 완전 중복(rawPath까지 동일) → 1개로 수렴", () => {
    // method={RequestMethod.GET, RequestMethod.GET} 류
    const out = assignRouteIds([
      route("GET", "/dup2", "C.java", 5),
      route("GET", "/dup2", "C.java", 5),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].routeId).toBe("route:GET /dup2");
    expect(out[0].notes).toEqual([]);
  });
});

test("routeNaturalKey / batchEntryId 형식", () => {
  expect(routeNaturalKey("GET", "/a/b")).toBe("GET /a/b");
  expect(batchEntryId("src/Job.java", "Job.run")).toBe("batch:src/Job.java#Job.run");
});

test("sortRoutes는 전순서 — 선행 4필드 동률이어도 입력 순서가 새지 않는다", () => {
  const a = { routeId: "route:GET /t@x", ...route("GET", "/t", "A.java", 1), rawPath: "/t" };
  const b = { routeId: "route:GET /t@y", ...route("GET", "/t", "A.java", 1), rawPath: "/t/" };
  expect(sortRoutes([b, a])).toEqual(sortRoutes([a, b]));
  expect(sortRoutes([b, a])[0].rawPath).toBe("/t");
});
