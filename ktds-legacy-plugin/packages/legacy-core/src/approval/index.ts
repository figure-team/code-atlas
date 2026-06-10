import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ApprovalRecord, Claim, Confidence, Evidence, DocState } from "../types.js";
import { CONFIDENCE_TAG, CLAIMS_FENCE_OPEN, CLAIMS_FENCE_CLOSE } from "../types.js";
import { setDocState, getDocState, loadDocStatus, transition } from "../doc-state/index.js";
import { logEvent } from "../audit/index.js";

/**
 * ApprovalWorkflow (plan §3.3 / §7.2): review → confirm [추정]·[확정(AI)] → approve.
 * Composes doc-state (transitions) + audit (events). 승인자 식별은 핸들/이니셜만(O3).
 */

const APPROVALS_FILE = "approvals.json";

export interface DraftEntry {
  doc: string;
  state: DocState;
}

/** List docs in DRAFT (plan: `review --list`). */
export async function listDrafts(specDir: string): Promise<DraftEntry[]> {
  const map = await loadDocStatus(specDir);
  return Object.entries(map)
    .filter(([, state]) => state === "DRAFT")
    .map(([doc, state]) => ({ doc, state }));
}

/** Begin review of a doc: DRAFT → UNDER_REVIEW. */
export async function startReview(specDir: string, doc: string): Promise<void> {
  await setDocState(specDir, doc, "UNDER_REVIEW");
}

/**
 * Promote a claim to human-confirmed ([확정(담당자)]). The reviewer takes
 * personal accountability — applies both to [추정]/INFERRED (no evidence) and
 * to [확정(AI)]/CONFIRMED_AI (AI verified, reviewer now signs off). Evidence is
 * preserved via spread. (`by` is a handle/initials, not a real name — O3.)
 */
export function confirmClaim(claim: Claim): Claim {
  return { ...claim, confidence: "CONFIRMED_HUMAN", requires_human_review: false };
}

/** Confirm a claim and emit DOC_ITEM_CONFIRMED (A17b). */
export async function confirmAndLog(
  specDir: string,
  doc: string,
  claim: Claim,
  by: string
): Promise<Claim> {
  const confirmed = confirmClaim(claim);
  await logEvent(specDir, "DOC_ITEM_CONFIRMED", { doc, by, detail: { claim: claim.claim } });
  return confirmed;
}

// ── .md ↔ claim 매핑 (plan A17b — 인터랙티브 확정) ──────────────────────────
// doc-generator renderClaim()의 역방향: 발행된 마크다운에서 claims 펜스 안의
// 확정 대상 라인을 찾아 [확정(담당자)]로 승격한다. 확정 대상 = [추정](INFERRED,
// 근거 없음) + [확정(AI)](CONFIRMED_AI, AI 근거 있음 → 담당자가 검증·책임 인수).
// 접두사/펜스는 types.ts 상수에서 조립해 렌더러와 동기화를 유지한다. 펜스
// 밖(LLM prose)의 유사 불릿은 claim이 아니다.
const CONFIRMED_PREFIX = `- ${CONFIDENCE_TAG.CONFIRMED_HUMAN} `;

/** Confidence values a reviewer may promote to CONFIRMED_HUMAN, with their bullet prefixes. */
const CONFIRMABLE: ReadonlyArray<{ from: Confidence; prefix: string }> = [
  { from: "INFERRED", prefix: `- ${CONFIDENCE_TAG.INFERRED} ` },
  { from: "CONFIRMED_AI", prefix: `- ${CONFIDENCE_TAG.CONFIRMED_AI} ` },
];

export interface ConfirmableItem {
  /** 1-based ordinal among the doc's current confirmable items (display order; shifts as items are confirmed). */
  index: number;
  /** 1-based line number in the published markdown — stable key for confirmLine. */
  line: number;
  /** Current confidence of the line ([추정] vs [확정(AI)]) — what is being promoted from. */
  from: Confidence;
  /** Claim text after the tag (evidence cite suffix stripped; see splitCite). */
  text: string;
}

/** renderClaim()의 cite 접미사(` — 근거: \`path:line\``)를 claim 본문과 evidence로 역파싱. */
function splitCite(rest: string): { text: string; evidence: Evidence[] } {
  const m = rest.match(/^(.*) — 근거: `([^`]+)`$/);
  if (!m) return { text: rest, evidence: [] };
  const ref = m[2];
  const colon = ref.lastIndexOf(":");
  const hasLine = colon > 0 && /^\d+$/.test(ref.slice(colon + 1));
  const ev: Evidence = hasLine
    ? { path: ref.slice(0, colon), line: Number(ref.slice(colon + 1)) }
    : { path: ref };
  return { text: m[1], evidence: [ev] };
}

/**
 * 라인 본문(접두사 제거 후)을 claim 본문 + evidence로 분해.
 * INFERRED는 계약상 근거가 없으므로(doc-generator inferredClaim) cite 파싱을 건너뛴다
 * → rest 전체가 claim 본문이라 [추정] 경로는 이전 동작과 증명적으로 동일.
 * cite 역파싱은 근거가 있는 CONFIRMED_AI에만 적용한다.
 */
function parseClaimBody(from: Confidence, rest: string): { text: string; evidence: Evidence[] } {
  return from === "CONFIRMED_AI" ? splitCite(rest) : { text: rest, evidence: [] };
}

/** 펜스 안의 확정 대상 라인 → {from, prefix} (0-based 라인 인덱스 키). list/confirm 공용. */
function scanConfirmableLines(mdLines: string[]): Map<number, { from: Confidence; prefix: string }> {
  const hits = new Map<number, { from: Confidence; prefix: string }>();
  let inClaims = false;
  mdLines.forEach((l, i) => {
    if (l === CLAIMS_FENCE_OPEN) inClaims = true;
    else if (l === CLAIMS_FENCE_CLOSE) inClaims = false;
    else if (inClaims) {
      const match = CONFIRMABLE.find((c) => l.startsWith(c.prefix));
      if (match) hits.set(i, match);
    }
  });
  return hits;
}

/** List the confirmable claim lines ([추정]·[확정(AI)]) of a published doc (`docsDir/doc`). */
export async function listConfirmableItems(docsDir: string, doc: string): Promise<ConfirmableItem[]> {
  const mdLines = (await readFile(join(docsDir, doc), "utf-8")).split("\n");
  const hits = scanConfirmableLines(mdLines);
  const items: ConfirmableItem[] = [];
  for (const i of [...hits.keys()].sort((a, b) => a - b)) {
    const { from, prefix } = hits.get(i)!;
    items.push({ index: items.length + 1, line: i + 1, from, text: parseClaimBody(from, mdLines[i].slice(prefix.length)).text });
  }
  return items;
}

/**
 * Promote one confirmable line ([추정] or [확정(AI)]) to [확정(담당자)] (plan A17b).
 * Guards: non-empty `by` handle (O3 — the only accountability record), doc must
 * be UNDER_REVIEW (review → confirm → approve), and `line` must currently hold a
 * confirmable claim inside the claims fence. Ordering mirrors approveDoc
 * (crash-gap safety): validate → audit (DOC_ITEM_CONFIRMED) → rewrite the .md
 * LAST, so a mid-write failure leaves the tag unconfirmed (retryable; at worst a
 * duplicate audit event) rather than a confirmed tag with no audit trail. The
 * evidence cite (if any, e.g. from [확정(AI)]) is preserved verbatim in the .md
 * and round-tripped onto the returned Claim.
 * 동시 검토자가 같은 라인을 다른 claim으로 바꿔치기하는 경쟁은 범위 밖
 * (UNDER_REVIEW 단일 검토자 가정) — 재검증이 non-claim 오태깅만은 막아준다.
 */
export async function confirmLine(
  specDir: string,
  docsDir: string,
  doc: string,
  line: number,
  by: string
): Promise<Claim> {
  const handle = by.trim();
  if (!handle) {
    throw new Error("[approval] confirmer handle (by) must be non-empty");
  }
  const state = await getDocState(specDir, doc);
  if (state !== "UNDER_REVIEW") {
    throw new Error(`[approval] cannot confirm in state ${state} (start review first: DRAFT -> UNDER_REVIEW)`);
  }
  const path = join(docsDir, doc);
  const lines = (await readFile(path, "utf-8")).split("\n");
  const hit = scanConfirmableLines(lines).get(line - 1);
  if (!hit) {
    throw new Error(
      `[approval] ${doc}:${line} is not a confirmable claim line ` +
        `(${CONFIDENCE_TAG.INFERRED}/${CONFIDENCE_TAG.CONFIRMED_AI})`
    );
  }
  const rest = lines[line - 1].slice(hit.prefix.length);
  const { text, evidence } = parseClaimBody(hit.from, rest);
  const claim: Claim = { claim: text, confidence: hit.from, evidence, requires_human_review: hit.from === "INFERRED" };
  const confirmed = await confirmAndLog(specDir, doc, claim, handle);
  lines[line - 1] = CONFIRMED_PREFIX + rest; // keep the cite suffix verbatim
  await writeFile(path, lines.join("\n"), "utf-8");
  return confirmed;
}

export async function loadApprovals(specDir: string): Promise<ApprovalRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(specDir, APPROVALS_FILE), "utf-8");
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[approval] ${APPROVALS_FILE} is corrupt (invalid JSON)`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[approval] ${APPROVALS_FILE} is malformed (expected an array)`);
  }
  return parsed as ApprovalRecord[];
}

/**
 * Approve a doc: UNDER_REVIEW → APPROVED. `by` = handle/initials (O3).
 * Ordering (crash-gap safety): validate the transition early (illegal approve
 * records nothing), persist approvals.json + audit, then flip state LAST — so a
 * mid-write failure leaves the doc UNDER_REVIEW (retryable) rather than an
 * APPROVED doc with no approval record.
 */
export async function approveDoc(specDir: string, doc: string, by: string): Promise<ApprovalRecord> {
  const from = await getDocState(specDir, doc);
  transition(from, "APPROVED"); // pure validation; throws if not UNDER_REVIEW, persists nothing

  const record: ApprovalRecord = { doc, by, at: new Date().toISOString() };
  const approvals = await loadApprovals(specDir);
  approvals.push(record);
  const path = join(specDir, APPROVALS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(approvals, null, 2), "utf-8");
  await logEvent(specDir, "DOC_APPROVED", { doc, by });

  await setDocState(specDir, doc, "APPROVED"); // flip state last
  return record;
}

/** Return a doc for revision: UNDER_REVIEW → RETURNED. */
export async function returnDoc(specDir: string, doc: string): Promise<void> {
  await setDocState(specDir, doc, "RETURNED");
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
