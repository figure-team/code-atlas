import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildCensus } from "./census.js";
import { extractRoutes } from "./extract.js";
import type { BatchEntry, RouteEntry } from "./types.js";

// 14.3/14.4 DoD: 픽스처 명세표 대비 recall 100% — 기대 집합과 추출 집합의
// 완전 일치(누락도 과추출도 없음)를 픽스처 디렉토리별로 검증한다.

const FIXTURES = resolve(
  import.meta.dirname,
  "../../../../../fixtures/route-extraction",
);

interface ExpectedFile {
  routes: Array<
    Pick<RouteEntry, "method" | "path" | "kind" | "framework" | "handler" | "notes">
  >;
  batchEntries: Array<
    Pick<BatchEntry, "trigger" | "schedule" | "handler" | "filePath">
  >;
}

function sortByJson<T>(items: T[]): T[] {
  return [...items]
    .map((i) => JSON.stringify(i))
    .sort()
    .map((s) => JSON.parse(s) as T);
}

const FIXTURE_DIRS = [
  "spring-basic",
  "stripes-app",
  "webxml-app",
  "batch-app",
  "nextjs-app",
];

describe.each(FIXTURE_DIRS)("route extraction fixture: %s", (dir) => {
  test("기대 명세표와 전수 일치 (recall 100%)", async () => {
    const root = join(FIXTURES, dir);
    const expected = JSON.parse(
      await readFile(join(root, "expected.json"), "utf-8"),
    ) as ExpectedFile;

    const census = await buildCensus(root);
    const report = await extractRoutes(root, census);

    const actualRoutes = report.routes.map((r) => ({
      method: r.method,
      path: r.path,
      kind: r.kind,
      framework: r.framework,
      handler: r.handler,
      notes: r.notes,
    }));
    expect(sortByJson(actualRoutes)).toEqual(sortByJson(expected.routes));

    const actualBatch = report.batchEntries.map((b) => ({
      trigger: b.trigger,
      schedule: b.schedule,
      handler: b.handler,
      filePath: b.filePath,
    }));
    expect(sortByJson(actualBatch)).toEqual(sortByJson(expected.batchEntries));

    // Evidence anchors: every entry carries a deterministic 1-based line.
    for (const r of report.routes) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.routeId.startsWith("route:")).toBe(true);
    }
    for (const b of report.batchEntries) {
      expect(b.line).toBeGreaterThan(0);
      expect(b.entryId.startsWith("batch:")).toBe(true);
    }
  });
});

test("spring 픽스처: routeId는 (method, path) 자연키이며 중복이 없다", async () => {
  const root = join(FIXTURES, "spring-basic");
  const census = await buildCensus(root);
  const report = await extractRoutes(root, census);
  const ids = report.routes.map((r) => r.routeId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("route:GET /orders/list");
  expect(ids).toContain("route:POST /orders/sync");
});

test("webxml 픽스처: evidence 라인이 url-pattern 선언 라인을 가리킨다", async () => {
  const root = join(FIXTURES, "webxml-app");
  const census = await buildCensus(root);
  const report = await extractRoutes(root, census);
  const webXmlRaw = await readFile(
    join(root, "src/main/webapp/WEB-INF/web.xml"),
    "utf-8",
  );
  const lines = webXmlRaw.split("\n");
  for (const r of report.routes.filter((x) => x.framework === "webxml")) {
    expect(lines[r.line - 1]).toContain(r.rawPath);
  }
});
