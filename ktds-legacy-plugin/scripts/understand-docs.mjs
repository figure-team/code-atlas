#!/usr/bin/env node
// /understand-docs — 근거 기반 5종 문서 생성 + 검토/승인/감사.
//   생성:   node understand-docs.mjs <projectRoot> [runId]
//   검토:   node understand-docs.mjs <projectRoot> review --list
//           node understand-docs.mjs <projectRoot> review --doc <file> [--by <handle>]   (TTY면 [추정]·[확정(AI)] 인터랙티브 확정)
//   확정:   node understand-docs.mjs <projectRoot> confirm --doc <file>                            (TTY: 항목 골라 확정 세션 — 담당자 1회 입력, 세션 중 변경 가능)
//           node understand-docs.mjs <projectRoot> confirm --doc <file> --list
//           node understand-docs.mjs <projectRoot> confirm --doc <file> --item <n> --by <handle>   (비대화 1건 — 자동화용)
//   승인:   node understand-docs.mjs <projectRoot> approve --doc <file> --by <handle>
//   반려:   node understand-docs.mjs <projectRoot> return  --doc <file>
//   감사:   node understand-docs.mjs <projectRoot> audit --list | audit --date <YYYY-MM-DD>
//
// 결정론 skeleton만 생성. 실제 LLM 산문은 host CLI(Claude)가 SKILL.md 지시로 채운다.
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
const TAGLABEL = { INFERRED: "[추정]", CONFIRMED_AI: "[확정(AI)]", NEEDS_REVIEW: "[확인 필요]" };
const argv = process.argv.slice(2);
const root = argv[0] && !argv[0].startsWith("-") && !SUBS.includes(argv[0]) ? argv[0] : process.cwd();
const rest = argv[0] === root ? argv.slice(1) : argv;
const sub = rest[0];
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(n);
const spec = join(root, ".spec");
const docDir = join(root, "docs");

// 확정 대상 태그별 개수 — 펜스 안 claim만(engine listConfirmableItems와 동일 기준).
// review --list/--doc 가 같은 카운터를 쓰도록 통일(prose 속 유사 태그 미집계).
async function confirmableCounts(doc) {
  const items = await listConfirmableItems(docDir, doc).catch(() => []);
  return {
    inferred: items.filter((i) => i.from === "INFERRED").length,
    ai: items.filter((i) => i.from === "CONFIRMED_AI").length,
    review: items.filter((i) => i.from === "NEEDS_REVIEW").length,
  };
}

// 인터랙티브 확정 세션 (plan A17b). 확정 대상([추정]·[확정(AI)])을 목록으로 보여주고
// 항목 번호로 콕 집어 [확정(담당자)] 승격한다. 확정 즉시 .md 태그 치환 + DOC_ITEM_CONFIRMED
// 감사. 라인 번호가 안정 키라 확정으로 순번이 줄어도 안전(매 확정 후 목록 재계산).
//
// 담당자 핸들은 이번 실행(세션) 동안만 메모리에 유지 — 최초 1회 입력 후 재사용, 세션 중
// `by <핸들>`로 변경 가능, 디스크 미저장(O3: 실명/사번 미저장, 감사엔 실제 사용 핸들만 기록).
async function interactiveConfirm(doc, byFlag) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q).catch(() => null); // EOF(Ctrl+D) → null
  let by = byFlag?.trim() || "";
  let confirmed = 0;
  try {
    if (!by) {
      by = ((await ask("확정 담당자 핸들/이니셜 (엔터 = 취소): ")) ?? "").trim();
      if (!by) { console.log("  핸들 미입력 — 확정 단계 생략"); return; }
    }
    for (;;) {
      const items = await listConfirmableItems(docDir, doc);
      if (items.length === 0) { console.log("  확정 대상 없음 — 세션 종료"); break; }
      console.log(`\n  담당자: ${by} · 확정 대상 ${items.length}건`);
      for (const it of items) console.log(`    ${it.index}. ${TAGLABEL[it.from]} ${it.text}`);
      const ans = ((await ask("  번호=해당 항목 확정 · a=전체 확정 · by <핸들>=담당자 변경 · q=종료 > ")) ?? "").trim();
      if (ans === "" || ans === "q") break;
      if (ans === "a") {
        let ok = 0;
        for (const it of items) {
          // 항목별 실패 격리: 한 건이 막혀도(드문 경쟁) 세션을 끊지 않고 계속.
          try { await confirmLine(spec, docDir, doc, it.line, by); ok++; confirmed++; }
          catch (e) { console.log(`    #${it.index} 건너뜀 — ${e.message}`); }
        }
        console.log(`    → ${ok}/${items.length}건 [확정(담당자)] (by ${by})`);
        continue;
      }
      if (ans === "by" || ans.startsWith("by ")) {
        const next = (ans === "by" ? ((await ask("    새 담당자 핸들: ")) ?? "") : ans.slice(3)).trim();
        if (next) { by = next; console.log(`    담당자 → ${by}`); }
        else console.log("    변경 취소(빈 핸들)");
        continue;
      }
      if (/^\d+$/.test(ans)) {
        const it = items.find((x) => x.index === Number(ans));
        if (!it) { console.log(`    항목 ${ans} 없음 (현재 1..${items.length})`); continue; }
        await confirmLine(spec, docDir, doc, it.line, by);
        confirmed++;
        console.log(`    #${it.index} → [확정(담당자)] (by ${by})`);
        continue;
      }
      console.log("    인식 못한 입력 — 번호 / a / by <핸들> / q");
    }
    console.log(confirmed > 0 ? `  확정 ${confirmed}건 완료.` : "  확정 없이 종료.");
  } finally {
    rl.close();
  }
}

try {
  if (sub === "review" && has("--list")) {
    const drafts = await listDrafts(spec);
    console.log(`DRAFT 문서 ${drafts.length}건:`);
    for (const d of drafts) {
      const t = await confirmableCounts(d.doc);
      console.log(`  - ${d.doc}   [추정] ${t.inferred} · [확정(AI)] ${t.ai} · [확인 필요] ${t.review}`);
    }
  } else if (sub === "review" && flag("--doc")) {
    const doc = flag("--doc");
    await startReview(spec, doc);
    const items = await listConfirmableItems(docDir, doc);
    const nInf = items.filter((i) => i.from === "INFERRED").length;
    const nAi = items.filter((i) => i.from === "CONFIRMED_AI").length;
    const nNr = items.filter((i) => i.from === "NEEDS_REVIEW").length;
    console.log(`검토 시작: ${doc} → ${await getDocState(spec, doc)}`);
    console.log(`  확정 대상 ${items.length}건 ([추정] ${nInf} · [확정(AI)] ${nAi} · [확인 필요] ${nNr}) (담당자 확정 후 approve)`);
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
