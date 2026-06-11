import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCensus, createCensusIgnoreFilter, isTestPath } from "./census.js";

const execFileAsync = promisify(execFile);

// 14.2 DoD: main 소스 전수 포함, 테스트 제외 정확, KG 교차 2계층 보고, 결정론.
// 리뷰 반영: U-A ignore 정합(3-레이어·negation·기본 패턴), git/walk 모드 공통
// 도구 상태 디렉토리 제외, git 모드에서의 KG 교차검증·untracked 포함.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ktds-census-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
}

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: dir });
}

const BASE_FILES: Record<string, string> = {
  "src/main/java/com/a/App.java": "public class App {}\n",
  "src/main/java/com/a/Extra.java": "public class Extra {}\n",
  "src/main/java/com/a/UtilTest.java": "public class UtilTest {}\n",
  "src/test/java/com/a/AppIntegration.java": "public class AppIntegration {}\n",
  "generated/Gen.java": "public class Gen {}\n",
  "target/classes/Build.java": "public class Build {}\n",
  ".understandignore": "generated/\n",
  "README.md": "# readme\n",
};

const KG = JSON.stringify({
  version: "1.0.0",
  nodes: [
    { id: "n1", type: "file", filePath: "src/main/java/com/a/App.java" },
    { id: "n2", type: "file", filePath: "src/test/java/com/a/AppIntegration.java" },
    { id: "n3", type: "file", filePath: "generated/Gen.java" },
    { id: "n4", type: "file", filePath: "src/main/java/com/a/Deleted.java" },
    { id: "n5", type: "class", filePath: "src/main/java/com/a/App.java" },
    { id: "n6", type: "file", filePath: "target/classes/Build.java" },
  ],
  edges: [],
});

function relPaths(census: Awaited<ReturnType<typeof buildCensus>>): string[] {
  return census.files.map((f) => f.relPath);
}

describe("buildCensus (비-git 폴백 walk)", () => {
  test("소스 전수 포함 + 테스트/ignore/U-A기본/비소스 제외 + KG 2계층 교차보고", async () => {
    await seed({
      ...BASE_FILES,
      ".understand-anything/knowledge-graph.json": KG,
    });

    const census = await buildCensus(dir);

    expect(relPaths(census)).toEqual([
      "src/main/java/com/a/App.java",
      "src/main/java/com/a/Extra.java",
    ]);
    expect(census.fileCount).toBe(2);
    expect(census.gitCommit).toBeNull();

    // KG 교차: 필터로 설명되는 제외(ignored — 테스트 경로, .understandignore,
    // U-A 기본 패턴 target/) vs 설명 안 되는 누락(missing)
    expect(census.kgCrossCheck).not.toBeNull();
    expect(census.kgCrossCheck!.kgOnlyIgnored).toEqual([
      "generated/Gen.java",
      "src/test/java/com/a/AppIntegration.java",
      "target/classes/Build.java",
    ]);
    expect(census.kgCrossCheck!.kgOnlyMissing).toEqual([
      "src/main/java/com/a/Deleted.java",
    ]);
    expect(census.kgCrossCheck!.censusOnly).toEqual([
      "src/main/java/com/a/Extra.java",
    ]);
  });

  test("KG 부재 시 kgCrossCheck=null", async () => {
    await seed(BASE_FILES);
    const census = await buildCensus(dir);
    expect(census.kgCrossCheck).toBeNull();
  });

  test("결정론: 동일 입력 2회 → 동일 구조", async () => {
    await seed(BASE_FILES);
    const a = await buildCensus(dir);
    const b = await buildCensus(dir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildCensus (git 모드)", () => {
  test("untracked 포함 + tracked-but-deleted 제외 + 도구 상태 디렉토리 미유입 + KG 교차", async () => {
    await seed({
      ...BASE_FILES,
      // 도구 상태/산출물 디렉토리 — 대상 repo의 .gitignore에 없어도 census에
      // 절대 들어가면 안 된다 (git/walk 모드 발산 + 자기 피드백 차단)
      ".spec/map/leftover.xml": "<beans/>\n",
      ".omc/state.yaml": "a: 1\n",
      ".understand-anything/knowledge-graph.json": KG,
    });
    await git("init", "-q");
    await git("add", "src/main/java/com/a/App.java");
    // tracked 후 삭제된 파일은 census에서 빠져야 한다 (downstream ENOENT 방지)
    await git("add", "src/main/java/com/a/Extra.java");
    await rm(join(dir, "src/main/java/com/a/Extra.java"));

    const census = await buildCensus(dir);

    // App.java=tracked, Deleted=없음; untracked인 BASE 후보 중 살아남는 건 없고
    // 아래 New.java가 untracked 포함을 단언한다
    await seed({ "src/main/java/com/a/New.java": "public class New {}\n" });
    const census2 = await buildCensus(dir);

    expect(relPaths(census)).toEqual(["src/main/java/com/a/App.java"]);
    expect(relPaths(census2)).toEqual([
      "src/main/java/com/a/App.java",
      "src/main/java/com/a/New.java", // untracked, --others로 포함
    ]);
    for (const p of relPaths(census2)) {
      expect(p.startsWith(".spec/")).toBe(false);
      expect(p.startsWith(".omc/")).toBe(false);
      expect(p.startsWith(".understand-anything/")).toBe(false);
    }
    // 커밋이 없으므로 HEAD 없음 → null
    expect(census.gitCommit).toBeNull();

    // KG 교차검증이 git 모드 경로 표기에서도 동일하게 동작
    expect(census2.kgCrossCheck).not.toBeNull();
    expect(census2.kgCrossCheck!.kgOnlyMissing).toEqual([
      "src/main/java/com/a/Deleted.java",
    ]);
    expect(census2.kgCrossCheck!.kgOnlyIgnored).toContain(
      "src/test/java/com/a/AppIntegration.java",
    );
    expect(census2.kgCrossCheck!.censusOnly).toEqual([
      "src/main/java/com/a/New.java",
    ]);
  });
});

describe("ignore 필터 (U-A 정합)", () => {
  test("3-레이어: .understand-anything/.understandignore도 적용", async () => {
    await seed({
      "src/main/java/A.java": "class A {}\n",
      "gen2/G.java": "class G {}\n",
      ".understand-anything/.understandignore": "gen2/\n",
    });
    const census = await buildCensus(dir);
    expect(relPaths(census)).toEqual(["src/main/java/A.java"]);
  });

  test("negation(!) 지원 — gitignore 의미론", async () => {
    await seed({
      "src/a/Old.bak.java": "class Old {}\n",
      "src/a/Keep.bak.java": "class Keep {}\n",
      ".understandignore": "*.bak.java\n!Keep.bak.java\n",
    });
    const census = await buildCensus(dir);
    expect(relPaths(census)).toEqual(["src/a/Keep.bak.java"]);
  });

  test("U-A 기본 패턴: target/·node_modules/·.mvn/ 자동 제외", async () => {
    await seed({
      "src/main/java/A.java": "class A {}\n",
      "target/Gen.java": "class Gen {}\n",
      "node_modules/x/index.js": "module.exports = 1;\n",
      ".mvn/wrapper/MavenWrapperDownloader.java": "class MavenWrapperDownloader {}\n",
      "sub/gradle/wrapper/GradleWrapperMain.java": "class GradleWrapperMain {}\n",
    });
    const census = await buildCensus(dir);
    expect(relPaths(census)).toEqual(["src/main/java/A.java"]);
  });

  test("createCensusIgnoreFilter 디렉토리 프로브", async () => {
    const filter = await createCensusIgnoreFilter(dir);
    expect(filter.isIgnoredDir("dist")).toBe(true);
    expect(filter.isIgnoredDir(".spec")).toBe(true);
    expect(filter.isIgnoredDir("src/main")).toBe(false);
  });
});

describe("필터 단위", () => {
  test("isTestPath: 표준 테스트 경로/접미사만 정확히 제외", () => {
    expect(isTestPath("src/test/java/A.java")).toBe(true);
    expect(isTestPath("tests/helper.ts")).toBe(true);
    expect(isTestPath("a/__tests__/b.ts")).toBe(true);
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.ts")).toBe(true);
    expect(isTestPath("src/main/java/FooTest.java")).toBe(true);
    expect(isTestPath("src/main/java/FooTests.java")).toBe(true);
    expect(isTestPath("src/main/java/FooTestCase.java")).toBe(true);
    // 과제외 금지: 패키지명에 test가 포함돼도 src/test/ 표준 경로가 아니면 포함
    expect(isTestPath("src/main/java/com/x/latest/Foo.java")).toBe(false);
    expect(isTestPath("src/main/java/Contest.java")).toBe(false);
    expect(isTestPath("src/main/webapp/test.jsp")).toBe(false);
  });
});
