import { afterEach, beforeEach, expect, test } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { scanDomainMap } from "./extract.js";
import { CensusReportSchema, RoutesReportSchema } from "./types.js";

// M1 (A11 확장): 동일 입력 2회 실행 → .spec/map/ 산출물 byte-diff=0.
// 직렬화 자체가 결정론 경계이므로 구조 비교가 아니라 바이트 비교여야 한다.

const FIXTURES = resolve(
  import.meta.dirname,
  "../../../../../fixtures/route-extraction",
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ktds-domain-map-determinism-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("scanDomainMap 2회 실행 → census.json/routes.json byte-diff=0", async () => {
  await cp(join(FIXTURES, "spring-basic"), dir, { recursive: true });

  await scanDomainMap(dir);
  const census1 = await readFile(join(dir, ".spec/map/census.json"), "utf-8");
  const routes1 = await readFile(join(dir, ".spec/map/routes.json"), "utf-8");

  await scanDomainMap(dir);
  const census2 = await readFile(join(dir, ".spec/map/census.json"), "utf-8");
  const routes2 = await readFile(join(dir, ".spec/map/routes.json"), "utf-8");

  expect(census2).toBe(census1);
  expect(routes2).toBe(routes1);

  // 산출물은 스키마에 적합해야 한다 (14.1 DoD)
  expect(() => CensusReportSchema.parse(JSON.parse(census1))).not.toThrow();
  expect(() => RoutesReportSchema.parse(JSON.parse(routes1))).not.toThrow();
});

test("git 모드: 2회 실행 byte-diff=0 + gitCommit 40-hex (리뷰 반영 — 실전 주 경로)", async () => {
  await cp(join(FIXTURES, "spring-basic"), dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: dir });
  await git("init", "-q");
  await git("add", "-A");
  await git(
    "-c", "user.email=test@ktds.test",
    "-c", "user.name=ktds-test",
    "commit", "-q", "-m", "fixture",
  );

  const run1 = await scanDomainMap(dir);
  const census1 = await readFile(join(dir, ".spec/map/census.json"), "utf-8");
  const routes1 = await readFile(join(dir, ".spec/map/routes.json"), "utf-8");

  await scanDomainMap(dir);
  const census2 = await readFile(join(dir, ".spec/map/census.json"), "utf-8");
  const routes2 = await readFile(join(dir, ".spec/map/routes.json"), "utf-8");

  expect(census2).toBe(census1);
  expect(routes2).toBe(routes1);
  expect(run1.census.gitCommit).toMatch(/^[0-9a-f]{40}$/);
  // 1회차가 만든 .spec/map/ 산출물이 2회차 census에 유입되지 않는다
  expect(run1.census.files.every((f) => !f.relPath.startsWith(".spec/"))).toBe(true);
});

test("산출물에 타임스탬프성 필드가 없다 (재실행 diff=0의 전제)", async () => {
  await cp(join(FIXTURES, "stripes-app"), dir, { recursive: true });
  const { census, routes } = await scanDomainMap(dir);
  const serialized = JSON.stringify({ census, routes });
  expect(serialized).not.toMatch(/scannedAt|analyzedAt|timestamp|generatedAt/i);
});
