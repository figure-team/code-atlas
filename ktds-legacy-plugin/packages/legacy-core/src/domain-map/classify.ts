import type {
  CandidatesReport,
  CensusReport,
  DomainCandidate,
  DomainFile,
  RoutesReport,
  SlicesReport,
} from "./types.js";

// S4-S5 도메인 분류 (Stage-16, tasks 16.1-16.3).
// 신호 우선순위: 도달성(주) > 디렉토리(교차 검증) > 파일명 prefix(폴백).
// - 도달성 sole 소유 → 그 루트의 도메인 (간선이 곧 증거)
// - shared → common 격리 후보
// - unreached → 디렉토리/파일명 신호로 폴백, 그래도 없으면 미해소 큐 (보고)
// 디렉토리 분류기는 speclinker 알고리즘의 TS 재구현(원작자 허락, ADR D7):
// 과반(>50%) 하강으로 도메인 부모 디렉토리를 찾고, 레이어/구조 키워드를
// 건너뛴 첫 세그먼트를 토큰으로 삼는다. 퇴화(후보 <2 / 단일 집중) 감지 시
// 파일명 prefix 클러스터(Anquetil–Lethbridge식 토큰화의 클린룸 구현 —
// GPLv3 Spiral 코드 미사용)로 분기한다.

/** 구조/패키지 루트 세그먼트 — 도메인 의미 없음, 토큰 탐색에서 건너뜀. */
const SKIP_SEGMENTS = new Set([
  "src", "main", "test", "java", "kotlin", "resources", "webapp", "app",
  "apps", "lib", "libs", "source", "sources",
  // 패키지 루트 관례 (역도메인)
  "com", "org", "net", "io", "kr", "co", "jp", "us", "edu", "gov",
]);

/** 레이어/기술 계층 세그먼트 — 도메인 토큰이 될 수 없음. */
const LAYER_SEGMENTS = new Set([
  "web", "web-inf", "actions", "action", "controller", "controllers",
  "service", "services", "mapper", "mappers", "dao", "daos", "repository",
  "repositories", "domain", "model", "models", "entity", "entities", "dto",
  "vo", "bo", "impl", "util", "utils", "common", "commons", "core", "config",
  "configuration", "api", "rest", "batch", "job", "jobs", "handler",
  "handlers", "view", "views", "jsp", "pages", "page", "components",
  "component", "hooks", "types", "interfaces", "helper", "helpers",
  "support", "base", "internal", "shared", "filter", "filters",
  "interceptor", "interceptors", "listener", "listeners", "exception",
  "exceptions", "constant", "constants", "enums", "facade", "facades",
  "manager", "managers", "module", "modules",
]);

/** 파일명 토큰 중 도메인 의미가 없는 접미/계층 토큰 (16.2 폴백용). */
const STOP_TOKENS = new Set([
  "action", "bean", "controller", "service", "mapper", "dao", "repository",
  "impl", "abstract", "base", "test", "tests", "util", "utils", "helper",
  "manager", "handler", "listener", "filter", "interceptor", "exception",
  "dto", "vo", "bo", "form", "view", "page", "config", "configuration",
  "factory", "builder", "provider", "resolver", "validator", "converter",
  "index", "main", "app", "common", "web",
  // Next.js 파일 라우팅 관례 — 파일명은 역할이고 도메인은 디렉토리다
  "route", "layout", "error", "loading", "template", "document",
  "middleware", "slug", "id", "params",
]);

// ── 16.1 디렉토리 분류기 ───────────────────────────────────────────────────

export interface DirectoryClassification {
  /** relPath → 도메인 토큰 (신호 없는 파일은 미포함). */
  tokenByFile: Map<string, string>;
  degenerate:
    | { reason: "too-few-clusters" | "single-cluster-concentration" }
    | null;
}

/**
 * 과반 하강: 루트에서 시작해 단일 자식 디렉토리가 전체 파일의 >50%를 담는
 * 동안 내려간다 — 엄격 LCP보다 견고(소수 이탈 파일이 공통 prefix를 끊어도
 * 다수 경로를 따라간다). 멈춘 지점 이후 첫 비-구조·비-레이어 세그먼트가
 * 그 파일의 도메인 토큰이다.
 */
export function classifyByDirectory(relPaths: string[]): DirectoryClassification {
  const dirSegs = relPaths.map((p) => {
    const segs = p.split("/");
    segs.pop(); // 파일명 제거
    return segs.map((s) => s.toLowerCase());
  });

  // 과반 하강으로 공통 prefix 깊이 결정.
  // 알려진 한계: 한 도메인 디렉토리가 전체의 >50%를 차지하면 그 안으로
  // 하강해 버려 형제 도메인과 깊이가 어긋난다 — 그 경우 클러스터가
  // 흩어져 퇴화 감지가 발동하고 prefix 폴백이 받는다(조용한 오분류 없음).
  let depth = 0;
  for (;;) {
    const counts = new Map<string, number>();
    for (const segs of dirSegs) {
      if (segs.length > depth) {
        counts.set(segs[depth], (counts.get(segs[depth]) ?? 0) + 1);
      }
    }
    let top: string | null = null;
    let topCount = 0;
    for (const [seg, count] of [...counts.entries()].sort()) {
      if (count > topCount) {
        top = seg;
        topCount = count;
      }
    }
    if (top === null || topCount * 2 <= relPaths.length) break;
    depth++;
  }

  const tokenByFile = new Map<string, string>();
  for (let i = 0; i < relPaths.length; i++) {
    const segs = dirSegs[i];
    for (let d = depth; d < segs.length; d++) {
      const seg = segs[d];
      // dot-디렉토리(.github/.mvn)·숫자 디렉토리는 인프라 — 도메인 토큰 불가.
      // Next.js 라우팅 장치도 건너뛴다: (group)/@slot/[dynamic]/_private.
      if (
        /^[.([@_]/.test(seg) ||
        /^\d+$/.test(seg) ||
        SKIP_SEGMENTS.has(seg) ||
        LAYER_SEGMENTS.has(seg)
      ) {
        continue;
      }
      tokenByFile.set(relPaths[i], seg);
      break;
    }
  }

  // 퇴화 감지 (16.1): 서로 다른 토큰 <2 (분리 불능) 또는 최대 클러스터가
  // 전체의 >60% 집중. 클러스터 크기는 묻지 않는다 — 작은 프로젝트에선
  // 크기 1 클러스터들도 유효한 분리다 (Next.js 픽스처 실측).
  const clusterSizes = new Map<string, number>();
  for (const token of tokenByFile.values()) {
    clusterSizes.set(token, (clusterSizes.get(token) ?? 0) + 1);
  }
  let degenerate: DirectoryClassification["degenerate"] = null;
  if (clusterSizes.size < 2) {
    degenerate = { reason: "too-few-clusters" };
  } else {
    const top = Math.max(...clusterSizes.values());
    if (top * 100 > relPaths.length * 60) {
      degenerate = { reason: "single-cluster-concentration" };
    }
  }
  return { tokenByFile, degenerate };
}

// ── 16.2 파일명 prefix 폴백 ────────────────────────────────────────────────

/** "AccountActionBean.java" → ["account","action","bean"], "line_item.sql" → ["line","item"]. */
export function tokenizeBasename(relPath: string): string[] {
  const base = relPath.split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .map((t) => t.toLowerCase().replace(/[[\]()@{}]/g, ""))
    .filter((t) => t.length > 0);
}

/** 첫 비-STOP 토큰 = prefix. 전부 STOP이면 null (도메인 신호 없음). */
export function prefixToken(relPath: string): string | null {
  for (const token of tokenizeBasename(relPath)) {
    if (!STOP_TOKENS.has(token) && !/^\d+$/.test(token)) return token;
  }
  return null;
}

// ── 16.3 신호 통합 ─────────────────────────────────────────────────────────

export function buildCandidates(
  census: CensusReport,
  routes: RoutesReport,
  slices: SlicesReport,
): CandidatesReport {
  const allFiles = census.files.map((f) => f.relPath);
  const directory = classifyByDirectory(allFiles);
  const dirToken = (p: string): string | null =>
    directory.degenerate ? null : (directory.tokenByFile.get(p) ?? null);

  // 도메인 시드 = 루트(엔트리 파일).
  // 디렉토리 토큰은 루트들을 실제로 구별할 때만 루트 key가 된다 —
  // package-by-layer 구조(모든 컨트롤러가 한 디렉토리)에서는 루트 전원이
  // 같은 토큰을 받아 도메인이 하나로 붕괴하므로(jpetstore 실측), 그 경우
  // 파일명 prefix가 루트 key다. 파일 단위 디렉토리 신호(JSP 등)는 그대로 유효.
  const rootDirTokens = new Set(
    slices.slices.map((s) => dirToken(s.root)).filter((t): t is string => t !== null),
  );
  const dirDistinguishesRoots = rootDirTokens.size >= 2;
  const rootKey = new Map<string, string>();
  for (const slice of slices.slices) {
    const key =
      (dirDistinguishesRoots ? dirToken(slice.root) : null) ??
      prefixToken(slice.root) ??
      (slice.root.split("/").pop() ?? slice.root).replace(/\.[^.]+$/, "").toLowerCase();
    rootKey.set(slice.root, key);
  }

  const entryCountByRoot = new Map<string, number>();
  for (const slice of slices.slices) {
    entryCountByRoot.set(slice.root, slice.entryIds.length);
  }

  // key → candidate 골격
  const byKey = new Map<string, { roots: string[]; files: DomainFile[] }>();
  const candidateOf = (key: string): { roots: string[]; files: DomainFile[] } => {
    let c = byKey.get(key);
    if (!c) {
      c = { roots: [], files: [] };
      byKey.set(key, c);
    }
    return c;
  };
  for (const [root, key] of [...rootKey.entries()].sort()) {
    candidateOf(key).roots.push(root);
  }

  const common: Array<{ relPath: string; owners: string[] }> = [];
  const ambiguous: CandidatesReport["ambiguous"] = [];
  const unresolved: string[] = [];

  for (const own of slices.ownership) {
    const isRoot = rootKey.has(own.relPath);
    if (own.status === "shared") {
      // 루트 자신이 다른 루트의 슬라이스에 들어간 경우라도 루트는 자기
      // 도메인의 닻이다 — common으로 빼지 않는다.
      if (!isRoot) common.push({ relPath: own.relPath, owners: own.owners });
      continue;
    }
    if (own.status === "sole") {
      const ownerKey = rootKey.get(own.owners[0])!;
      if (isRoot) continue; // 루트는 이미 등재
      const dKey = dirToken(own.relPath);
      if (dKey !== null && byKey.has(dKey) && dKey !== ownerKey) {
        // 도달성과 디렉토리 신호 충돌 → 모호 큐 (어느 쪽에도 배정하지 않음)
        ambiguous.push({ relPath: own.relPath, reachKey: ownerKey, directoryKey: dKey });
      } else {
        candidateOf(ownerKey).files.push({ relPath: own.relPath, via: "reachability" });
      }
      continue;
    }
    // unreached → 디렉토리 > prefix 폴백, 기존 도메인 key에만 합류
    const dKey = dirToken(own.relPath);
    if (dKey !== null && byKey.has(dKey)) {
      candidateOf(dKey).files.push({ relPath: own.relPath, via: "directory" });
      continue;
    }
    const pKey = prefixToken(own.relPath);
    if (pKey !== null && byKey.has(pKey)) {
      candidateOf(pKey).files.push({ relPath: own.relPath, via: "prefix" });
      continue;
    }
    unresolved.push(own.relPath);
  }

  const candidates: DomainCandidate[] = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, c]) => ({
      key,
      roots: [...c.roots].sort(),
      entryCount: c.roots.reduce((n, r) => n + (entryCountByRoot.get(r) ?? 0), 0),
      files: [...c.files].sort((x, y) =>
        x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0,
      ),
    }));

  return {
    schemaVersion: 1,
    gitCommit: census.gitCommit,
    directoryDegenerate: directory.degenerate,
    candidates,
    common: common.sort((a, b) => (a.relPath < b.relPath ? -1 : 1)),
    ambiguous: ambiguous.sort((a, b) => (a.relPath < b.relPath ? -1 : 1)),
    unresolved: unresolved.sort(),
  };
}
