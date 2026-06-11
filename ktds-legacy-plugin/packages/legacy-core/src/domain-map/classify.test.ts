import { expect, test } from "vitest";
import {
  buildCandidates,
  classifyByDirectory,
  prefixToken,
  tokenizeBasename,
} from "./classify.js";
import type {
  CensusReport,
  EdgesReport,
  RoutesReport,
  SlicesReport,
} from "./types.js";
import { buildSlices } from "./slices.js";

// 16.1~16.3 도메인 분류 단위 테스트.

function census(...relPaths: string[]): CensusReport {
  return {
    schemaVersion: 1,
    gitCommit: null,
    fileCount: relPaths.length,
    files: relPaths.map((relPath) => ({ relPath, lang: "java" })),
    kgCrossCheck: null,
  };
}

function routesFor(roots: string[]): RoutesReport {
  return {
    schemaVersion: 1,
    gitCommit: null,
    contextPath: null,
    routes: roots.map((filePath, i) => ({
      routeId: `route:GET /r${i}`,
      method: "GET" as const,
      path: `/r${i}`,
      rawPath: `/r${i}`,
      kind: "api" as const,
      framework: "spring" as const,
      filePath,
      line: 1,
      handler: null,
      notes: [],
    })),
    batchEntries: [],
  };
}

function edgesOf(...pairs: Array<[string, string]>): EdgesReport {
  return {
    schemaVersion: 1,
    gitCommit: null,
    edges: pairs.map(([source, target]) => ({
      source,
      target,
      kind: "import" as const,
      line: 1,
    })),
    unresolved: [],
  };
}

// ── 16.2 토큰화 ────────────────────────────────────────────────────────────

test("파일명 토큰화: camelCase/snake/kebab", () => {
  expect(tokenizeBasename("AccountActionBean.java")).toEqual(["account", "action", "bean"]);
  expect(tokenizeBasename("line_item.sql")).toEqual(["line", "item"]);
  expect(tokenizeBasename("order-history.jsp")).toEqual(["order", "history"]);
  expect(tokenizeBasename("HTTPClientUtil.java")).toEqual(["http", "client", "util"]);
});

test("prefix 토큰: 첫 비-STOP 토큰, 전부 STOP이면 null", () => {
  expect(prefixToken("a/AccountService.java")).toBe("account");
  expect(prefixToken("a/AbstractActionBean.java")).toBe(null);
  expect(prefixToken("a/LineItemMapper.java")).toBe("line");
  // web.xml: 확장자 제거 후 "web"은 STOP → null (루트 key는 stem "web" 폴백 — 리뷰 고정)
  expect(prefixToken("src/main/webapp/WEB-INF/web.xml")).toBe(null);
});

// ── 16.1 디렉토리 분류기 ───────────────────────────────────────────────────

const NKSHOP = [
  "src/main/java/com/nkshop/order/OrderController.java",
  "src/main/java/com/nkshop/order/OrderRepo.java",
  "src/main/java/com/nkshop/order/OrderEntity.java",
  "src/main/java/com/nkshop/member/MemberController.java",
  "src/main/java/com/nkshop/member/MemberRepo.java",
  "src/main/java/com/nkshop/product/ProductController.java",
  "src/main/java/com/nkshop/product/ProductRepo.java",
];

test("package-by-feature(nkshop형): 과반 하강 후 도메인 디렉토리 정확 분리", () => {
  const r = classifyByDirectory(NKSHOP);
  expect(r.degenerate).toBe(null);
  expect(r.tokenByFile.get(NKSHOP[0])).toBe("order");
  expect(r.tokenByFile.get(NKSHOP[3])).toBe("member");
  expect(r.tokenByFile.get(NKSHOP[5])).toBe("product");
});

test("퇴화 감지: 단일 디렉토리 집중 → too-few-clusters", () => {
  const flat = [
    "src/main/java/com/app/web/A.java",
    "src/main/java/com/app/web/B.java",
    "src/main/java/com/app/web/C.java",
  ];
  const r = classifyByDirectory(flat);
  expect(r.degenerate).not.toBe(null);
});

test("Next.js: 그룹/슬롯/동적 세그먼트는 스킵, 디렉토리가 도메인 토큰 (M5)", () => {
  const files = [
    "app/(marketing)/about/page.tsx",
    "app/@modal/login/page.tsx",
    "app/api/items/[id]/route.ts",
    "pages/products/[slug].tsx",
  ];
  const r = classifyByDirectory(files);
  expect(r.degenerate).toBe(null);
  expect(r.tokenByFile.get(files[0])).toBe("about");
  expect(r.tokenByFile.get(files[1])).toBe("login");
  expect(r.tokenByFile.get(files[2])).toBe("items");
  expect(r.tokenByFile.get(files[3])).toBe("products");
  // 파일명 page/route/[slug]는 prefix 신호가 아니다
  expect(prefixToken(files[0])).toBe(null);
  expect(prefixToken(files[3])).toBe(null);
});

test("dot-디렉토리는 도메인 토큰이 될 수 없다", () => {
  const r = classifyByDirectory([
    ...NKSHOP,
    ".github/workflows/ci.yaml",
    ".github/workflows/cd.yaml",
  ]);
  expect(r.tokenByFile.has(".github/workflows/ci.yaml")).toBe(false);
});

// ── 16.3 신호 통합 ─────────────────────────────────────────────────────────

test("package-by-layer(jpetstore형): 루트 디렉토리 토큰 미구별 → prefix가 루트 key", () => {
  const files = [
    "src/main/java/com/app/web/AccountController.java",
    "src/main/java/com/app/web/OrderController.java",
    "src/main/java/com/app/service/AccountService.java",
    "src/main/java/com/app/service/OrderService.java",
  ];
  const c = census(...files);
  const roots = [files[0], files[1]];
  const r = routesFor(roots);
  const e = edgesOf([files[0], files[2]], [files[1], files[3]]);
  const s = buildSlices(c, r, e);
  const result = buildCandidates(c, r, s);
  expect(result.candidates.map((x) => x.key)).toEqual(["account", "order"]);
  // sole 도달 파일은 reachability로 귀속
  expect(result.candidates[0].files).toEqual([
    { relPath: files[2], via: "reachability" },
  ]);
});

test("shared 파일은 common, 어느 도메인에도 배정되지 않는다", () => {
  const files = [
    "src/main/java/com/app/web/AccountController.java",
    "src/main/java/com/app/web/OrderController.java",
    "src/main/java/com/app/service/SharedService.java",
  ];
  const c = census(...files);
  const r = routesFor([files[0], files[1]]);
  const e = edgesOf([files[0], files[2]], [files[1], files[2]]);
  const s = buildSlices(c, r, e);
  const result = buildCandidates(c, r, s);
  expect(result.common).toEqual([
    { relPath: files[2], owners: [files[0], files[1]] },
  ]);
  for (const cand of result.candidates) {
    expect(cand.files.some((f) => f.relPath === files[2])).toBe(false);
  }
});

test("unreached 파일: 디렉토리/prefix 신호로 기존 도메인 합류, 불가 시 미해소 큐", () => {
  const files = [
    "src/main/java/com/shop/order/OrderController.java",
    "src/main/java/com/shop/order/OrderRepo.java",
    "src/main/java/com/shop/member/MemberController.java",
    "src/main/java/com/shop/member/MemberProfile.java",
    // unreached — 디렉토리 신호(order)로 합류해야 함
    "src/main/java/com/shop/order/OrderHistoryView.java",
    // unreached — 디렉토리 신호 없음(구조 경로), prefix(member)로 합류
    "src/main/webapp/common/MemberBanner.jsp",
    // unreached — 어떤 신호도 없음 → 미해소
    "src/main/resources/schema.sql",
  ];
  const c = census(...files);
  const r = routesFor([files[0], files[2]]);
  const s = buildSlices(c, r, edgesOf());
  const result = buildCandidates(c, r, s);
  const order = result.candidates.find((x) => x.key === "order")!;
  const member = result.candidates.find((x) => x.key === "member")!;
  expect(order.files).toContainEqual({ relPath: files[4], via: "directory" });
  expect(member.files).toContainEqual({ relPath: files[5], via: "prefix" });
  expect(result.unresolved).toEqual([files[6]]);
});

test("신호 충돌(도달성 vs 디렉토리)은 모호 큐로 — 어느 쪽에도 배정 금지", () => {
  const files = [
    "src/main/java/com/shop/order/OrderController.java",
    "src/main/java/com/shop/order/OrderRepo.java",
    "src/main/java/com/shop/member/MemberController.java",
    // order 루트만 도달하지만 디렉토리는 member를 가리킴
    "src/main/java/com/shop/member/MemberDiscount.java",
  ];
  const c = census(...files);
  const r = routesFor([files[0], files[2]]);
  const e = edgesOf([files[0], files[1]], [files[0], files[3]]);
  const s = buildSlices(c, r, e);
  const result = buildCandidates(c, r, s);
  expect(result.ambiguous).toEqual([
    { relPath: files[3], reachKey: "order", directoryKey: "member" },
  ]);
  for (const cand of result.candidates) {
    expect(cand.files.some((f) => f.relPath === files[3])).toBe(false);
  }
});

test("결정론: 입력 순서가 후보 출력에 새지 않는다", () => {
  const files = [
    "src/main/java/com/shop/order/OrderController.java",
    "src/main/java/com/shop/member/MemberController.java",
  ];
  const make = (order: string[]): string => {
    const c = census(...order);
    const r = routesFor(order);
    const s = buildSlices(c, r, edgesOf());
    return JSON.stringify(buildCandidates(c, r, s).candidates.map((x) => x.key));
  };
  expect(make(files)).toBe(make([...files].reverse()));
});
