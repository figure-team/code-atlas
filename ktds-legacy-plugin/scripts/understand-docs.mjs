#!/usr/bin/env node
// /understand-docs — 근거 기반 5종 문서 생성 + 검토/승인/감사.
//   생성:   node understand-docs.mjs <projectRoot> [runId]
//   검토:   node understand-docs.mjs <projectRoot> review --list
//           node understand-docs.mjs <projectRoot> review --doc <file> [--by <handle>]   (TTY면 [추정]·[확정(AI)] 인터랙티브 확정)
//   확정:   node understand-docs.mjs <projectRoot> confirm --doc <file> --list
//           node understand-docs.mjs <projectRoot> confirm --doc <file> --item <n> --by <handle>
//   승인:   node understand-docs.mjs <projectRoot> approve --doc <file> --by <handle>
//   반려:   node understand-docs.mjs <projectRoot> return  --doc <file>
//   감사:   node understand-docs.mjs <projectRoot> audit --list | audit --date <YYYY-MM-DD>
//
// 결정론 skeleton만 생성. 실제 LLM 산문은 host CLI(Claude)가 SKILL.md 지시로 채운다.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ensureBuilt } from "./ensure-built.mjs";

// `... | head` 처럼 reader가 먼저 닫히면 stdout EPIPE가 throw된다 — 정상 종료로 흡수.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

const {
  runDocsPipeline, listDrafts, startReview, approveDoc, returnDoc,
  readAudit, getDocState, listConfirmableItems, confirmLine,
} = await import(await ensureBuilt());

const SUBS = ["review", "approve", "return", "audit", "confirm"];
// 확정 대상의 현재 신뢰도 → 표시 태그 (engine ConfirmableItem.from).
const TAGLABEL = { INFERRED: "[추정]", CONFIRMED_AI: "[확정(AI)]" };
const argv = process.argv.slice(2);
const root = argv[0] && !argv[0].startsWith("-") && !SUBS.includes(argv[0]) ? argv[0] : process.cwd();
const rest = argv[0] === root ? argv.slice(1) : argv;
const sub = rest[0];
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(n);
const spec = join(root, ".spec");
const docDir = join(root, "docs");

async function tagCounts(doc) {
  const md = await readFile(join(docDir, doc), "utf-8").catch(() => "");
  return {
    inferred: (md.match(/\[추정\]/g) || []).length,
    ai: (md.match(/\[확정\(AI\)\]/g) || []).length,
    review: (md.match(/\[확인 필요\]/g) || []).length,
  };
}

// 확정 대상([추정]·[확정(AI)])을 하나씩 보여주며 y/n/q 로 [확정(담당자)] 승격하는
// 인터랙티브 루프 (plan A17b). 확정 즉시 .md 태그 치환 + DOC_ITEM_CONFIRMED 감사.
// 라인 번호가 안정 키라서 도중 확정으로 순번이 줄어도 스냅샷 순회가 안전하다
// (태그 치환은 라인 수 불변).
async function interactiveConfirm(doc, byFlag) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // EOF(Ctrl+D)로 닫히면 question이 reject → null 반환해 정상 종료(q와 동일) 처리.
  const ask = (q) => rl.question(q).catch(() => null);
  try {
    const by = byFlag?.trim() || ((await ask("확정 담당자 핸들/이니셜 (엔터 = 확정 생략): ")) ?? "").trim();
    if (!by) { console.log("  핸들 미입력 — 확정 단계 생략"); return; }
    const items = await listConfirmableItems(docDir, doc);
    let confirmed = 0;
    for (const it of items) {
      const ans = (await ask(`  [${it.index}/${items.length}] ${TAGLABEL[it.from]} ${it.text}\n    [확정(담당자)]로 확정? [y/N/q] `))
        ?.trim().toLowerCase();
      if (ans == null || ans === "q") break;
      if (ans !== "y") continue;
      await confirmLine(spec, docDir, doc, it.line, by);
      confirmed++;
      console.log(`    → [확정(담당자)] (by ${by})`);
    }
    console.log(`  확정 ${confirmed}건 / 확정 대상 잔여 ${items.length - confirmed}건`);
  } finally {
    rl.close();
  }
}

try {
  if (sub === "review" && has("--list")) {
    const drafts = await listDrafts(spec);
    console.log(`DRAFT 문서 ${drafts.length}건:`);
    for (const d of drafts) {
      const t = await tagCounts(d.doc);
      console.log(`  - ${d.doc}   [추정] ${t.inferred} · [확정(AI)] ${t.ai} · [확인 필요] ${t.review}`);
    }
  } else if (sub === "review" && flag("--doc")) {
    const doc = flag("--doc");
    await startReview(spec, doc);
    const items = await listConfirmableItems(docDir, doc);
    const t = await tagCounts(doc);
    const nInf = items.filter((i) => i.from === "INFERRED").length;
    const nAi = items.filter((i) => i.from === "CONFIRMED_AI").length;
    console.log(`검토 시작: ${doc} → ${await getDocState(spec, doc)}`);
    console.log(`  확정 대상 ${items.length}건 ([추정] ${nInf} · [확정(AI)] ${nAi}) · [확인 필요] ${t.review}건 (담당자 확정 후 approve)`);
    if (items.length > 0) {
      if (process.stdin.isTTY) await interactiveConfirm(doc, flag("--by"));
      else console.log(`  비대화 모드 — confirm --doc ${doc} --list 로 확인 후 confirm --doc ${doc} --item <n> --by <handle>`);
    }
  } else if (sub === "confirm" && has("--list")) {
    const doc = flag("--doc");
    if (!doc) throw new Error("usage: confirm --doc <file> --list");
    const items = await listConfirmableItems(docDir, doc);
    console.log(`확정 대상 ${items.length}건 (${doc}):`);
    for (const it of items) console.log(`  ${it.index}. (L${it.line}) ${TAGLABEL[it.from]} ${it.text}`);
  } else if (sub === "confirm") {
    const doc = flag("--doc"), by = flag("--by")?.trim(), n = flag("--item");
    if (!doc) throw new Error("usage: confirm --doc <file> [--list | --item <n> --by <handle>]");
    if (!n) {
      if (!process.stdin.isTTY) throw new Error("usage: confirm --doc <file> --item <n> --by <handle> (비대화 모드)");
      await interactiveConfirm(doc, by);
    } else {
      if (!by) throw new Error("usage: confirm --doc <file> --item <n> --by <handle>");
      if (!/^\d+$/.test(n) || Number(n) < 1) throw new Error(`--item 은 1 이상의 정수여야 합니다: ${n}`);
      const items = await listConfirmableItems(docDir, doc);
      if (items.length === 0) throw new Error(`확정 대상 없음 (${doc})`);
      const it = items.find((x) => x.index === Number(n));
      if (!it) throw new Error(`확정 항목 ${n} 없음 (현재 1..${items.length})`);
      await confirmLine(spec, docDir, doc, it.line, by);
      console.log(`확정: ${doc} #${it.index} ${TAGLABEL[it.from]} "${it.text}" → [확정(담당자)] (by ${by})`);
    }
  } else if (sub === "approve") {
    const doc = flag("--doc"), by = flag("--by");
    if (!doc || !by) throw new Error("usage: approve --doc <file> --by <handle>");
    const rec = await approveDoc(spec, doc, by);
    console.log(`승인 완료: ${doc} → ${await getDocState(spec, doc)} (by ${rec.by}, ${rec.at})`);
  } else if (sub === "return") {
    const doc = flag("--doc");
    if (!doc) throw new Error("usage: return --doc <file>");
    await returnDoc(spec, doc);
    console.log(`반려: ${doc} → ${await getDocState(spec, doc)}`);
  } else if (sub === "audit") {
    const date = flag("--date");
    const events = await readAudit(spec, date ? { date } : {});
    console.log(`감사 로그 ${events.length}건${date ? ` (${date})` : ""}:`);
    for (const e of events) {
      console.log(`  ${e.ts}  ${e.type}${e.doc ? " · " + e.doc : ""}${e.by ? " · by " + e.by : ""}`);
    }
  } else {
    const runId = rest[0] && !rest[0].startsWith("-") ? rest[0] : `run-${Date.now()}`;
    const res = await runDocsPipeline(root, { runId });
    console.log(`DRAFT 생성: ${res.published.join(", ")}`);
    console.log(`→ ${res.docsDir} · 검토: understand-docs.mjs ${root} review --list`);
  }
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exitCode = 1;
}
