import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFills } from "../domain-map/verify.js";
import type { Citation, DomainFill } from "../domain-map/fill.js";
import { verifyImpactClaims, type ImpactClaimItem } from "./verify.js";

// T5 DoD: 골든 — 동일 인용에 domain-map verifyFills와 status 동치(복제 드리프트
// 방어) + path-escape/trivial/line-out-of-range/text-mismatch 케이스.

let dir: string;
const FOO = "src/Foo.java";
// line1: public class Foo {   line2:   private Bar bar; // 주문은 회원만 가능하다   line3: }
const FOO_SRC = "public class Foo {\n  private Bar bar; // 주문은 회원만 가능하다\n}\n";

// 모두 snippet ≥8자 + 식별자 토큰 → trivial 아님 (DomainFill min8 통과).
// Citation(snippet 필수)으로 선언해 DomainFill·ImpactCitation 양쪽에 호환.
const C_OK: Citation = { filePath: FOO, line: 2, snippet: "private Bar bar;" };
const C_KO: Citation = { filePath: FOO, line: 2, snippet: "주문은 회원만 가능하다" }; // HIGH-1: CJK 가중/토큰 분기
const C_MISMATCH: Citation = { filePath: FOO, line: 1, snippet: "private Bar bar;" };
const C_NOFILE: Citation = { filePath: "src/Missing.java", line: 1, snippet: "public class Foo" };
const C_OOR: Citation = { filePath: FOO, line: 99, snippet: "public class Foo" };
const C_ESCAPE: Citation = { filePath: "../escape.java", line: 1, snippet: "public class Foo" };
const ALL = [C_OK, C_KO, C_MISMATCH, C_NOFILE, C_OOR, C_ESCAPE];

const key = (c: { filePath: string; line: number; snippet?: string }) =>
  `${c.filePath}|${c.line}|${c.snippet}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ktds-impact-verify-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, FOO), FOO_SRC, "utf-8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("골든 동치: impact verifyCitation == domain-map verifyFills (5 status)", async () => {
  // domain-map 경로: DomainFill에 같은 인용을 실어 verifyFills 실행
  const fill: DomainFill = {
    schemaVersion: 1,
    domainId: "domain:x",
    name: "X",
    summary: { text: "요약", citations: [C_OK] },
    entities: [
      { text: "엔터티0(한글근거)", citations: [C_KO] },
      { text: "엔터티1", citations: [C_MISMATCH] },
      { text: "엔터티2", citations: [C_NOFILE] },
      { text: "엔터티3", citations: [C_OOR] },
      { text: "엔터티4", citations: [C_ESCAPE] },
    ],
    businessRules: [],
    crossDomainInteractions: [],
    flows: [],
    steps: [],
  };
  const dmReport = await verifyFills(dir, [fill], null);
  const dmStatus = new Map<string, string>();
  for (const d of dmReport.domains)
    for (const it of d.items)
      for (const c of it.citations) dmStatus.set(key(c), c.status);

  // impact 경로: 같은 인용
  const items: ImpactClaimItem[] = ALL.map((c, i) => ({
    kind: "file",
    ref: `item-${i}`,
    text: "주장",
    citations: [c],
  }));
  const imReport = await verifyImpactClaims(dir, items, null);
  const imStatus = new Map<string, string>();
  for (const it of imReport.items) for (const c of it.citations) imStatus.set(key(c), c.status);

  // 두 검증기가 모든 인용에 같은 status
  for (const c of ALL) {
    expect(imStatus.get(key(c))).toBe(dmStatus.get(key(c)));
  }
  // 구체 status 확인
  expect(imStatus.get(key(C_OK))).toBe("ok");
  expect(imStatus.get(key(C_KO))).toBe("ok"); // CJK 가중·토큰 분기도 동치 (HIGH-1)
  expect(imStatus.get(key(C_MISMATCH))).toBe("text-mismatch");
  expect(imStatus.get(key(C_NOFILE))).toBe("no-file");
  expect(imStatus.get(key(C_OOR))).toBe("line-out-of-range");
  expect(imStatus.get(key(C_ESCAPE))).toBe("path-escape");
});

test("trivial-snippet: 짧은/식별자 없는 스니펫 + 빈 snippet 강등", async () => {
  const items: ImpactClaimItem[] = [
    { kind: "file", ref: "trivial", text: "t", citations: [{ filePath: FOO, line: 1, snippet: ") {" }] },
    { kind: "file", ref: "empty", text: "e", citations: [{ filePath: FOO, line: 1 }] }, // snippet 없음
  ];
  const r = await verifyImpactClaims(dir, items, null);
  expect(r.items.find((i) => i.ref === "trivial")!.citations[0].status).toBe("trivial-snippet");
  expect(r.items.find((i) => i.ref === "empty")!.citations[0].status).toBe("trivial-snippet");
});

test("verdict + groundedPct: ok 인용 1개면 GROUNDED", async () => {
  const items: ImpactClaimItem[] = [
    { kind: "file", ref: "g", text: "g", citations: [C_OK] },
    { kind: "file", ref: "n", text: "n", citations: [C_NOFILE] },
  ];
  const r = await verifyImpactClaims(dir, items, null);
  expect(r.items.find((i) => i.ref === "g")!.verdict).toBe("GROUNDED");
  expect(r.items.find((i) => i.ref === "n")!.verdict).toBe("NEEDS_REVIEW");
  expect(r.overall.itemTotal).toBe(2);
  expect(r.overall.itemGrounded).toBe(1);
  expect(r.overall.groundedPct).toBe(50);
  expect(r.overall.citationOk).toBe(1);
});

test("항목 정렬 결정론 (kind, ref)", async () => {
  const items: ImpactClaimItem[] = [
    { kind: "mapper", ref: "z", text: "t", citations: [C_OK] },
    { kind: "api", ref: "b", text: "t", citations: [C_OK] },
    { kind: "api", ref: "a", text: "t", citations: [C_OK] },
  ];
  const r = await verifyImpactClaims(dir, items, null);
  expect(r.items.map((i) => `${i.kind}/${i.ref}`)).toEqual(["api/a", "api/b", "mapper/z"]);
});
