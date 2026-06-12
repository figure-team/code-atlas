#!/usr/bin/env node
// T9 변경 영향 정확도 하네스 — 수동 정답지 대비 recall + precision (ADR-002 N3).
//   사용:  node impact-recall.mjs <projectRoot> <expected.json> [--min-recall <pct>] [--min-precision <pct>] [--json]
//   예:    node impact-recall.mjs ~/projects/ktds/jpetstore ../fixtures/impact-recall/jpetstore.expected.json --min-recall 90 --min-precision 100
//
// recall = mustAffect(상류/API/매퍼/흐름)가 산출에 포함된 비율.
// precision = mustNotAffect가 영향집합에 새지 않은 비율 (역방향은 hub로 recall
// 100% 위양성이 쉬워 precision 게이트가 핵심 — 리뷰 반영). 정답지는 사람이
// 소스를 직접 읽고 작성한다(산출물 역산 금지).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureBuilt } from "./ensure-built.mjs";

function usage(message) {
  if (message) console.error(`오류: ${message}`);
  console.error("사용: node impact-recall.mjs <projectRoot> <expected.json> [--min-recall <pct>] [--min-precision <pct>] [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = { minRecall: null, minPrecision: null, json: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--min-recall") {
    flags.minRecall = Number(args[++i]);
    if (!Number.isFinite(flags.minRecall)) usage("--min-recall 값이 숫자가 아닙니다");
  } else if (args[i] === "--min-precision") {
    flags.minPrecision = Number(args[++i]);
    if (!Number.isFinite(flags.minPrecision)) usage("--min-precision 값이 숫자가 아닙니다");
  } else if (args[i] === "--json") {
    flags.json = true;
  } else {
    positional.push(args[i]);
  }
}
if (positional.length !== 2) usage(positional.length < 2 ? "인자 부족" : "인자 과다");
const [projectRoot, expectedPath] = positional.map((p) => resolve(p));

const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
// fail-closed: 빈 정답지가 게이트를 통과(NaN/0 분모)하는 일을 막는다.
if (!Array.isArray(expected.cases) || expected.cases.length === 0) usage("정답지에 cases가 없습니다");
for (const c of expected.cases) {
  if (!Array.isArray(c.seeds) || c.seeds.length === 0) usage("빈 seeds");
  const ma = c.mustAffect ?? {};
  const n = (ma.upstreamFiles?.length ?? 0) + (ma.api?.length ?? 0) + (ma.mappers?.length ?? 0) + (ma.flows?.length ?? 0);
  if (n === 0) usage(`빈 mustAffect: ${c.seeds.join(", ")}`);
}

const { analyzeImpact } = await import(await ensureBuilt());

let totalExp = 0, totalFound = 0, forbiddenTotal = 0, violationsTotal = 0;
const cases = [];
for (const c of expected.cases) {
  const seeds = c.seeds.map((relPath) => ({ relPath, origin: "path", confidence: "CONFIRMED_HUMAN" }));
  const { result } = await analyzeImpact(projectRoot, seeds);
  const upFiles = new Set(result.upstream.files.map((f) => f.relPath));
  const apiIds = new Set(result.upstream.api.map((a) => a.id));
  const mappers = new Set(result.upstream.persistence.mappers.map((m) => m.relPath));
  const flows = new Set(result.upstream.flows.map((f) => f.flowId));
  const impactFiles = new Set([
    ...result.upstream.files.map((f) => f.relPath),
    ...result.downstream.files.map((f) => f.relPath),
    ...mappers,
  ]);

  const ma = c.mustAffect ?? {};
  const axes = [
    ["upstreamFiles", ma.upstreamFiles, upFiles],
    ["api", ma.api, apiIds],
    ["mappers", ma.mappers, mappers],
    ["flows", ma.flows, flows],
  ];
  const missing = {};
  let exp = 0, found = 0;
  for (const [name, list, set] of axes) {
    if (!list) continue;
    const miss = list.filter((x) => !set.has(x));
    exp += list.length;
    found += list.length - miss.length;
    if (miss.length) missing[name] = miss;
  }
  const forbidden = c.mustNotAffect ?? [];
  const violations = forbidden.filter((x) => impactFiles.has(x));

  totalExp += exp; totalFound += found;
  forbiddenTotal += forbidden.length; violationsTotal += violations.length;
  cases.push({
    seeds: c.seeds.map((s) => s.split("/").pop()),
    expected: exp, found, recallPct: round1((found / exp) * 100), missing,
    forbidden: forbidden.length, violations,
  });
}

const overallRecall = round1((totalFound / totalExp) * 100);
const overallPrecision = forbiddenTotal === 0 ? 100 : round1(((forbiddenTotal - violationsTotal) / forbiddenTotal) * 100);
const report = {
  project: expected.project, overallRecall, overallPrecision,
  totalExpected: totalExp, totalFound, forbiddenTotal, violationsTotal,
  cases, knownGaps: expected.knownGaps ?? [],
};

if (flags.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`변경 영향 정확도 — ${report.project}`);
  for (const c of cases) {
    const mark = c.recallPct === 100 && c.violations.length === 0 ? "✓" : "△";
    console.log(`  ${mark} [${c.seeds.join(", ")}]  recall ${c.recallPct}% (${c.found}/${c.expected})${c.violations.length ? `  위양성 ${c.violations.length}` : ""}`);
    for (const [axis, miss] of Object.entries(c.missing)) console.log(`      누락(${axis}): ${miss.join(", ")}`);
    for (const v of c.violations) console.log(`      위양성(mustNotAffect): ${v}`);
  }
  console.log(`  전체 recall ${overallRecall}% (${totalFound}/${totalExp}) · precision ${overallPrecision}% (위양성 ${violationsTotal}/${forbiddenTotal})`);
  if (report.knownGaps.length) {
    console.log("  알려진 결손:");
    for (const g of report.knownGaps) console.log(`    - ${g}`);
  }
}

let exitCode = 0;
if (flags.minRecall !== null && overallRecall < flags.minRecall) {
  console.error(`기준 미달: recall ${overallRecall}% < --min-recall ${flags.minRecall}%`);
  exitCode = 1;
}
if (flags.minPrecision !== null && overallPrecision < flags.minPrecision) {
  console.error(`기준 미달: precision ${overallPrecision}% < --min-precision ${flags.minPrecision}%`);
  exitCode = 1;
}
process.exit(exitCode);

function round1(n) {
  return Math.round(n * 10) / 10;
}
