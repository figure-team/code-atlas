import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Claim, GeneratedDoc } from "../types.js";
import {
  listDrafts, startReview, confirmClaim, confirmAndLog,
  approveDoc, returnDoc, loadApprovals,
  listConfirmableItems, confirmLine,
} from "./index.js";
import { setDocState, getDocState } from "../doc-state/index.js";
import { readAudit } from "../audit/index.js";
import { renderMarkdown } from "../doc-generator/index.js";

describe("approval workflow", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ktds-appr-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("confirmClaim turns an INFERRED claim into CONFIRMED_HUMAN", () => {
    const claim: Claim = { claim: "x", confidence: "INFERRED", evidence: [], requires_human_review: true };
    const out = confirmClaim(claim);
    expect(out.confidence).toBe("CONFIRMED_HUMAN");
    expect(out.requires_human_review).toBe(false);
  });

  it("confirmAndLog emits DOC_ITEM_CONFIRMED (A17b)", async () => {
    const claim: Claim = { claim: "LoginController handles /login", confidence: "INFERRED", evidence: [], requires_human_review: true };
    await confirmAndLog(dir, "04_api-spec.md", claim, "kim");
    const events = await readAudit(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "DOC_ITEM_CONFIRMED", doc: "04_api-spec.md", by: "kim" });
  });

  it("full DRAFT → UNDER_REVIEW → APPROVED flow + approvals.json + audit (A7)", async () => {
    await setDocState(dir, "04_api-spec.md", "UNDER_REVIEW"); // seed (after review)
    const rec = await approveDoc(dir, "04_api-spec.md", "kim");
    expect(rec).toMatchObject({ doc: "04_api-spec.md", by: "kim" });
    expect(rec.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await getDocState(dir, "04_api-spec.md")).toBe("APPROVED");
    const approvals = JSON.parse(await readFile(join(dir, "approvals.json"), "utf-8"));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].by).toBe("kim");

    const audit = await readAudit(dir);
    expect(audit.some((e) => e.type === "DOC_APPROVED" && e.doc === "04_api-spec.md")).toBe(true);
  });

  it("approving a doc that is not UNDER_REVIEW is rejected (A8)", async () => {
    // doc is DRAFT (default) → DRAFT→APPROVED is illegal
    await expect(approveDoc(dir, "fresh.md", "kim")).rejects.toThrow(/illegal transition/);
    expect(await loadApprovals(dir)).toEqual([]); // nothing recorded
  });

  it("startReview / returnDoc drive the state machine", async () => {
    await startReview(dir, "d.md");
    expect(await getDocState(dir, "d.md")).toBe("UNDER_REVIEW");
    await returnDoc(dir, "d.md");
    expect(await getDocState(dir, "d.md")).toBe("RETURNED");
    expect(await listDrafts(dir)).toEqual([]); // RETURNED is not DRAFT
  });

  it("listDrafts returns only DRAFT docs", async () => {
    await setDocState(dir, "draft.md", "UNDER_REVIEW");
    await setDocState(dir, "draft.md", "RETURNED");
    await setDocState(dir, "draft.md", "DRAFT");
    await setDocState(dir, "review.md", "UNDER_REVIEW");
    const drafts = await listDrafts(dir);
    expect(drafts.map((d) => d.doc)).toEqual(["draft.md"]);
  });

  describe("md ↔ claim mapping (A17b 인터랙티브 확정)", () => {
    const DOC = "02_architecture.md";
    let docsDir: string;

    const inferred = (text: string): Claim =>
      ({ claim: text, confidence: "INFERRED", evidence: [], requires_human_review: true });
    const confirmedAi = (text: string): Claim =>
      ({ claim: text, confidence: "CONFIRMED_AI", evidence: [{ path: "src/Web.java", line: 7 }], requires_human_review: false });

    beforeEach(async () => {
      docsDir = join(dir, "docs");
      await mkdir(docsDir, { recursive: true });
      // 실제 renderMarkdown 출력을 파싱해 렌더러↔파서 계약을 함께 검증한다.
      const doc: GeneratedDoc = {
        filename: DOC,
        title: "아키텍처",
        sections: [
          { heading: "레이어", claims: [inferred("레이어: web (3개 구성요소)"), confirmedAi("의존: A → B"), inferred("레이어: dao (2개 구성요소)")] },
        ],
      };
      await writeFile(join(docsDir, DOC), renderMarkdown(doc), "utf-8");
    });

    it("listConfirmableItems finds [추정] AND [확정(AI)] lines with ordinal + line + from", async () => {
      const items = await listConfirmableItems(docsDir, DOC);
      expect(items.map((i) => i.text)).toEqual([
        "레이어: web (3개 구성요소)", "의존: A → B", "레이어: dao (2개 구성요소)",
      ]);
      expect(items.map((i) => i.index)).toEqual([1, 2, 3]);
      expect(items.map((i) => i.from)).toEqual(["INFERRED", "CONFIRMED_AI", "INFERRED"]);
      // [확정(AI)] 항목의 cite는 text에서 분리되어 보인다.
      expect(items[1].text).toBe("의존: A → B");
    });

    it("confirmLine promotes an [추정] line, keeps others, and audits (A17b)", async () => {
      await setDocState(dir, DOC, "UNDER_REVIEW");
      const first = (await listConfirmableItems(docsDir, DOC)).find((i) => i.from === "INFERRED")!;
      const out = await confirmLine(dir, docsDir, DOC, first.line, "kim");
      expect(out.confidence).toBe("CONFIRMED_HUMAN");
      expect(out.evidence).toEqual([]); // INFERRED는 근거 없음

      const md = await readFile(join(docsDir, DOC), "utf-8");
      expect(md).toContain("- [확정(담당자)] 레이어: web (3개 구성요소)");
      expect(md).toContain("- [추정] 레이어: dao (2개 구성요소)"); // 나머지 추정은 그대로
      expect(md).toContain("- [확정(AI)] 의존: A → B — 근거: `src/Web.java:7`"); // AI 라인 불변

      const events = await readAudit(dir);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "DOC_ITEM_CONFIRMED", doc: DOC, by: "kim",
        detail: { claim: "레이어: web (3개 구성요소)" },
      });
    });

    it("confirmLine promotes a [확정(AI)] line to [확정(담당자)], preserving its evidence cite", async () => {
      await setDocState(dir, DOC, "UNDER_REVIEW");
      const ai = (await listConfirmableItems(docsDir, DOC)).find((i) => i.from === "CONFIRMED_AI")!;
      const out = await confirmLine(dir, docsDir, DOC, ai.line, "kim");
      expect(out.confidence).toBe("CONFIRMED_HUMAN");
      expect(out.evidence).toEqual([{ path: "src/Web.java", line: 7 }]); // 근거 round-trip 보존

      const md = await readFile(join(docsDir, DOC), "utf-8");
      // 태그만 승격, cite는 .md에 그대로
      expect(md).toContain("- [확정(담당자)] 의존: A → B — 근거: `src/Web.java:7`");
      expect(md).not.toContain("- [확정(AI)] 의존: A → B");

      const events = await readAudit(dir);
      // 감사 claim 텍스트는 cite 제거된 본문
      expect(events[0]).toMatchObject({ type: "DOC_ITEM_CONFIRMED", detail: { claim: "의존: A → B" } });

      // 승격된 라인은 더 이상 확정 대상이 아니다 (순번 재계산)
      const remaining = await listConfirmableItems(docsDir, DOC);
      expect(remaining.map((i) => i.from)).toEqual(["INFERRED", "INFERRED"]);
    });

    it("promotes a [확정(AI)] line whose cite has no line number ({path} only)", async () => {
      // configClaim 처럼 evidence가 {path} 뿐인 AI 라인 (예: pom.xml).
      const doc: GeneratedDoc = {
        filename: DOC,
        title: "기술 스택",
        sections: [{
          heading: "프레임워크",
          claims: [{ claim: "프레임워크/라이브러리: Spring", confidence: "CONFIRMED_AI", evidence: [{ path: "pom.xml" }], requires_human_review: false }],
        }],
      };
      await writeFile(join(docsDir, DOC), renderMarkdown(doc), "utf-8");
      await setDocState(dir, DOC, "UNDER_REVIEW");

      const [item] = await listConfirmableItems(docsDir, DOC);
      expect(item.text).toBe("프레임워크/라이브러리: Spring"); // cite 분리됨
      const out = await confirmLine(dir, docsDir, DOC, item.line, "kim");
      expect(out.evidence).toEqual([{ path: "pom.xml" }]); // line 없는 evidence round-trip

      const md = await readFile(join(docsDir, DOC), "utf-8");
      expect(md).toContain("- [확정(담당자)] 프레임워크/라이브러리: Spring — 근거: `pom.xml`");
    });

    it("rejects confirm unless UNDER_REVIEW (review → confirm → approve)", async () => {
      const [first] = await listConfirmableItems(docsDir, DOC); // doc은 DRAFT(기본)
      await expect(confirmLine(dir, docsDir, DOC, first.line, "kim"))
        .rejects.toThrow(/cannot confirm in state DRAFT/);
      // 가드 실패 시 파일/감사 모두 무변경
      expect(await readFile(join(docsDir, DOC), "utf-8")).toContain("- [추정] 레이어: web");
      expect(await readAudit(dir)).toEqual([]);
    });

    it("rejects a line that is not a confirmable claim", async () => {
      await setDocState(dir, DOC, "UNDER_REVIEW");
      await expect(confirmLine(dir, docsDir, DOC, 1, "kim")) // L1 = "# 아키텍처"
        .rejects.toThrow(/is not a confirmable claim line/);
      await expect(confirmLine(dir, docsDir, DOC, 9999, "kim"))
        .rejects.toThrow(/is not a confirmable claim line/);
      expect(await readAudit(dir)).toEqual([]);
    });

    it("ignores [추정]-looking bullets in LLM prose (outside the claims fence)", async () => {
      const doc: GeneratedDoc = {
        filename: DOC,
        title: "아키텍처",
        sections: [{
          heading: "레이어",
          prose: "설명 산문.\n- [추정] 산문이 흉내 낸 불릿 (claim 아님)",
          claims: [inferred("레이어: web (3개 구성요소)")],
        }],
      };
      await writeFile(join(docsDir, DOC), renderMarkdown(doc), "utf-8");

      const items = await listConfirmableItems(docsDir, DOC);
      expect(items.map((i) => i.text)).toEqual(["레이어: web (3개 구성요소)"]);

      // 산문 라인을 라인 번호로 직접 확정 시도해도 거부 + 무변경
      await setDocState(dir, DOC, "UNDER_REVIEW");
      const md = (await readFile(join(docsDir, DOC), "utf-8")).split("\n");
      const proseLine = md.findIndex((l) => l.includes("산문이 흉내 낸")) + 1;
      expect(proseLine).toBeGreaterThan(0);
      await expect(confirmLine(dir, docsDir, DOC, proseLine, "kim"))
        .rejects.toThrow(/is not a confirmable claim line/);
      expect(await readAudit(dir)).toEqual([]);
    });

    it("double-confirm of the same line is rejected with no second audit event", async () => {
      await setDocState(dir, DOC, "UNDER_REVIEW");
      const [first] = await listConfirmableItems(docsDir, DOC);
      await confirmLine(dir, docsDir, DOC, first.line, "kim");
      await expect(confirmLine(dir, docsDir, DOC, first.line, "kim"))
        .rejects.toThrow(/is not a confirmable claim line/);
      const confirms = (await readAudit(dir)).filter((e) => e.type === "DOC_ITEM_CONFIRMED");
      expect(confirms).toHaveLength(1);
    });

    it("rejects an empty/whitespace confirmer handle (O3)", async () => {
      await setDocState(dir, DOC, "UNDER_REVIEW");
      const [first] = await listConfirmableItems(docsDir, DOC);
      await expect(confirmLine(dir, docsDir, DOC, first.line, "  "))
        .rejects.toThrow(/must be non-empty/);
      expect(await readAudit(dir)).toEqual([]);
      expect(await readFile(join(docsDir, DOC), "utf-8")).toContain("- [추정] 레이어: web");
    });

    it("full review → confirm-all → approve flow leaves a complete audit trail", async () => {
      await startReview(dir, DOC);
      // 확정 대상 3건([추정]×2 + [확정(AI)]×1) 모두 라인 번호(안정 키)로 확정
      const lines = (await listConfirmableItems(docsDir, DOC)).map((i) => i.line);
      for (const line of lines) await confirmLine(dir, docsDir, DOC, line, "kim");
      expect(await listConfirmableItems(docsDir, DOC)).toEqual([]);
      await approveDoc(dir, DOC, "kim");
      expect(await getDocState(dir, DOC)).toBe("APPROVED");

      const types = (await readAudit(dir)).map((e) => e.type);
      expect(types).toEqual([
        "DOC_ITEM_CONFIRMED", "DOC_ITEM_CONFIRMED", "DOC_ITEM_CONFIRMED", "DOC_APPROVED",
      ]);
    });
  });

  it("throws (records nothing) on corrupt approvals.json", async () => {
    await setDocState(dir, "d.md", "UNDER_REVIEW");
    await writeFile(join(dir, "approvals.json"), "{ broken", "utf-8");
    await expect(approveDoc(dir, "d.md", "kim")).rejects.toThrow(/corrupt/);
    // state was NOT flipped to APPROVED (validation/record happens before the final setDocState)
    await expect(getDocState(dir, "d.md")).resolves.toBe("UNDER_REVIEW");
  });
});
