#!/usr/bin/env node
// 15.4 체인 누락률 하네스 — 수동 정답지 대비 도달성 recall 측정 (ADR §3 반증 게이트).
//   사용:  node chain-recall.mjs <projectRoot> <expected.json> [--min <pct>] [--json]
//   예:    node chain-recall.mjs /tmp/jpetstore-6 ../fixtures/chain-recall/jpetstore-6.expected.json --min 90
//
// 정답지는 사람이 소스를 직접 읽고 작성한다(산출물 역산 금지). recall이 기준
// 이하로 떨어지면 휴리스틱 개선이 아니라 누락 원인 분석이 먼저다 — "Java 내부
// 해소가 주요 누락 원인으로 드러나면 파서 재검토"(ADR-001 §3).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function usage(message) {
  if (message) console.error(`오류: ${message}`);
  console.error("사용: node chain-recall.mjs <projectRoot> <expected.json> [--min <pct>] [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = { min: null, json: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--min") {
    flags.min = Number(args[++i]);
    if (!Number.isFinite(flags.min)) usage("--min 값이 숫자가 아닙니다");
  } else if (args[i] === "--json") {
    flags.json = true;
  } else {
    positional.push(args[i]);
  }
}
if (positional.length !== 2) usage(positional.length < 2 ? "인자 부족" : "인자 과다");
const [projectRoot, expectedPath] = positional.map((p) => resolve(p));

const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
// fail-closed: 빈 정답지로 --min 게이트가 통과(NaN 비교)하는 일을 막는다.
if (!Array.isArray(expected.chains) || expected.chains.length === 0) {
  usage("정답지에 chains가 없습니다");
}
for (const chain of expected.chains) {
  if (!Array.isArray(chain.mustReach) || chain.mustReach.length === 0) {
    usage(`빈 mustReach: ${chain.root ?? "(root 미지정)"}`);
  }
}
const { scanDomainMap } = await import(
  join(here, "../packages/legacy-core/dist/domain-map/index.js")
);
const { slices } = await scanDomainMap(projectRoot);
const reachedByRoot = new Map(slices.slices.map((s) => [s.root, new Set(s.reached)]));

const chains = [];
let totalExpected = 0;
let totalFound = 0;
for (const chain of expected.chains) {
  const reached = reachedByRoot.get(chain.root);
  const missing = reached
    ? chain.mustReach.filter((f) => !reached.has(f))
    : [...chain.mustReach];
  const found = chain.mustReach.length - missing.length;
  totalExpected += chain.mustReach.length;
  totalFound += found;
  chains.push({
    root: chain.root,
    rootDetected: Boolean(reached),
    expected: chain.mustReach.length,
    found,
    recallPct: round1((found / chain.mustReach.length) * 100),
    missing,
  });
}
const report = {
  project: expected.project,
  totalExpected,
  totalFound,
  overallRecallPct: round1((totalFound / totalExpected) * 100),
  chains,
  knownGaps: expected.knownGaps ?? [],
};

if (flags.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`체인 누락률 리포트 — ${report.project}`);
  for (const c of chains) {
    const mark = c.recallPct === 100 ? "✓" : "△";
    console.log(
      `  ${mark} ${c.root.split("/").pop()}  recall ${c.recallPct}% (${c.found}/${c.expected})${c.rootDetected ? "" : "  [루트 미검출!]"}`,
    );
    for (const m of c.missing) console.log(`      누락: ${m}`);
  }
  console.log(
    `  전체 recall: ${report.overallRecallPct}% (${totalFound}/${totalExpected})`,
  );
  if (report.knownGaps.length > 0) {
    console.log("  알려진 결손:");
    for (const g of report.knownGaps) console.log(`    - ${g}`);
  }
}

if (flags.min !== null && report.overallRecallPct < flags.min) {
  console.error(`기준 미달: recall ${report.overallRecallPct}% < --min ${flags.min}%`);
  process.exit(1);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
