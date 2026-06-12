import { afterEach, beforeEach, expect, test } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanDomainMap } from "../domain-map/extract.js";
import type {
  CensusReport,
  EdgesReport,
  RoutesReport,
  SlicesReport,
} from "../domain-map/types.js";
import { ImpactOptionsSchema, ImpactResultSchema } from "./types.js";
import {
  analyzeImpact,
  buildImpactReport,
  ImpactInputMissingError,
  type ImpactInputs,
} from "./engine.js";

// T6 DoD: 동일 seeds+commit 2회 impact.json byte-diff=0(N1), 부재 throw,
// 순수 조립(upstream/downstream/api 배선).

const FIXTURES = resolve(import.meta.dirname, "../../../../../fixtures/route-extraction");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ktds-impact-engine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("analyzeImpact 2회 실행 → impact.json byte-diff=0 (N1)", async () => {
  await cp(join(FIXTURES, "spring-basic"), dir, { recursive: true });
  await scanDomainMap(dir, { autoApprove: true });

  // census에서 첫 java 파일을 시드로 (픽스처 내용에 독립적)
  const census: CensusReport = JSON.parse(await readFile(join(dir, ".spec/map/census.json"), "utf-8"));
  const javaFile = census.files.find((f) => f.lang === "java");
  expect(javaFile).toBeTruthy();
  const seeds = [{ relPath: javaFile!.relPath, origin: "path" as const, confidence: "CONFIRMED_HUMAN" as const }];

  await analyzeImpact(dir, seeds);
  const first = await readFile(join(dir, ".spec/map/impact.json"), "utf-8");
  await analyzeImpact(dir, seeds);
  const second = await readFile(join(dir, ".spec/map/impact.json"), "utf-8");
  expect(second).toBe(first);

  const parsed = ImpactResultSchema.parse(JSON.parse(first));
  expect(parsed.seeds[0].relPath).toBe(javaFile!.relPath);
  // impact.json엔 스니펫(파일 읽기 산물)이 안 들어간다 (결정론 경량 앵커만)
  expect(first).not.toMatch(/"snippet"/);
});

test(".spec/map 부재 → ImpactInputMissingError (안내 throw)", async () => {
  await expect(
    analyzeImpact(dir, [{ relPath: "X.java", origin: "path", confidence: "CONFIRMED_HUMAN" }]),
  ).rejects.toBeInstanceOf(ImpactInputMissingError);
});

test("buildImpactReport 순수 조립: upstream=역방향, downstream=정방향", () => {
  const census: CensusReport = {
    schemaVersion: 1, gitCommit: null, fileCount: 3,
    files: [
      { relPath: "A.java", lang: "java" },
      { relPath: "Seed.java", lang: "java" },
      { relPath: "B.java", lang: "java" },
    ],
    kgCrossCheck: null,
  };
  const edges: EdgesReport = {
    schemaVersion: 1, gitCommit: null,
    edges: [
      { source: "A.java", target: "Seed.java", kind: "field-type", line: 5 }, // A가 Seed에 의존 → upstream
      { source: "Seed.java", target: "B.java", kind: "field-type", line: 9 }, // Seed가 B에 의존 → downstream
    ],
    unresolved: [],
  };
  const routes: RoutesReport = { schemaVersion: 1, gitCommit: null, contextPath: null, routes: [], batchEntries: [] };
  const slices: SlicesReport = { schemaVersion: 1, gitCommit: null, depthCap: 12, slices: [], ownership: [] };
  const inputs: ImpactInputs = { census, routes, edges, slices, skeleton: null, confirmed: null, gitCommit: null };

  const result = buildImpactReport(
    inputs,
    [{ relPath: "Seed.java", origin: "path", confidence: "CONFIRMED_HUMAN" }],
    ImpactOptionsSchema.parse({}),
    { kgTableCatalog: [], mapperNamespaceByPath: new Map(), mapperLineCounts: new Map() },
  );

  expect(result.upstream.files.map((f) => f.relPath)).toEqual(["A.java"]);
  expect(result.downstream.files.map((f) => f.relPath)).toEqual(["B.java"]);
  expect(result.upstream.files[0].citation).toEqual({ filePath: "A.java", line: 5 });
  expect(() => ImpactResultSchema.parse(result)).not.toThrow();
});

test("buildImpactReport: 비-Java 시드 → needsReview 강등", () => {
  const census: CensusReport = {
    schemaVersion: 1, gitCommit: null, fileCount: 1,
    files: [{ relPath: "page.jsp", lang: "jsp" }], kgCrossCheck: null,
  };
  const inputs: ImpactInputs = {
    census,
    routes: { schemaVersion: 1, gitCommit: null, contextPath: null, routes: [], batchEntries: [] },
    edges: { schemaVersion: 1, gitCommit: null, edges: [], unresolved: [] },
    slices: { schemaVersion: 1, gitCommit: null, depthCap: 12, slices: [], ownership: [] },
    skeleton: null, confirmed: null, gitCommit: null,
  };
  const result = buildImpactReport(
    inputs,
    [{ relPath: "page.jsp", origin: "path", confidence: "CONFIRMED_HUMAN" }],
    ImpactOptionsSchema.parse({}),
    { kgTableCatalog: [], mapperNamespaceByPath: new Map(), mapperLineCounts: new Map() },
  );
  expect(result.needsReview.some((n) => n.ref === "page.jsp" && /비-Java/.test(n.reason))).toBe(true);
});
