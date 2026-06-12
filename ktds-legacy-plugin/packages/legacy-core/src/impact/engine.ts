import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  CENSUS_FILENAME,
  EDGES_FILENAME,
  ROUTES_FILENAME,
  SLICES_FILENAME,
  CensusReportSchema,
  EdgesReportSchema,
  RoutesReportSchema,
  SlicesReportSchema,
  type CensusReport,
  type ConfirmedPlan,
  type EdgeKind,
  type EdgesReport,
  type RoutesReport,
  type SkeletonReport,
  type SlicesReport,
} from "../domain-map/types.js";
import { readSkeleton, specMapDir, writeMapArtifact } from "../domain-map/persist.js";
import { readConfirmedPlan } from "../domain-map/confirm.js";
import { buildMapperNamespaceIndex } from "../domain-map/edges.js";
import { buildAdjacency, computeFanIn, reachClosure, type ReachedFile } from "./reach.js";
import { computeApiImpact } from "./api.js";
import { computePersistenceImpact } from "./persistence.js";
import { computeFlowImpact } from "./flow.js";
import {
  IMPACT_VERIFY_FILENAME,
  verifyImpactClaims,
  type ImpactClaimItem,
  type ImpactVerifyReport,
} from "./verify.js";
import {
  IMPACT_REPORT_FILENAME,
  ImpactOptionsSchema,
  ImpactResultSchema,
  type AffectedFile,
  type ImpactOptions,
  type ImpactResult,
  type ImpactSeed,
  type KgTableEntry,
  type NeedsReviewItem,
} from "./types.js";

// T6 — 엔진 조립 + 결정론 (ADR-002 ID4). 순수 조립(buildImpactReport)과 IO
// 래퍼(analyzeImpact)를 분리한다. 엔진은 .spec/map/ 영속 산출물을 재스캔 0회로
// 로드하고(M4 예산), 모든 사실은 정렬·무타임스탬프라 동일 seeds+commit이면
// impact.json byte-diff=0(N1). 의미론: upstream(역방향)→API/흐름 영향,
// downstream(정방향)→DB/영속성 영향. 인용은 {filePath,line} 앵커만 impact.json에
// 담고(경량), 스니펫은 검증 시점에만 채워 impact-verify-report.json에 기록한다.

export class ImpactInputMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpactInputMissingError";
  }
}

export interface ImpactInputs {
  census: CensusReport;
  routes: RoutesReport;
  edges: EdgesReport;
  slices: SlicesReport;
  skeleton: SkeletonReport | null;
  confirmed: ConfirmedPlan | null;
  gitCommit: string | null;
}

export interface ImpactExtras {
  kgTableCatalog: KgTableEntry[];
  /** relPath → MyBatis namespace (mapper XML). */
  mapperNamespaceByPath: Map<string, string>;
  /** relPath → 라인 수 (tableCandidateSlots.endLine). */
  mapperLineCounts: Map<string, number>;
}

export interface AnalyzeImpactResult {
  result: ImpactResult;
  verify: ImpactVerifyReport;
  impactPath: string;
  verifyPath: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── 입력 로드 (재스캔 0회) ────────────────────────────────────────────────────

async function readArtifact<T>(
  dir: string,
  filename: string,
  schema: { parse: (v: unknown) => T },
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, filename), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImpactInputMissingError(
        `${filename} 없음 — 먼저 /understand-map scan을 실행하세요(.spec/map/ 산출물 필요)`,
      );
    }
    throw err;
  }
  return schema.parse(JSON.parse(raw));
}

export async function loadImpactInputs(projectRoot: string): Promise<ImpactInputs> {
  const dir = specMapDir(projectRoot);
  const [census, routes, edges, slices] = await Promise.all([
    readArtifact(dir, CENSUS_FILENAME, CensusReportSchema),
    readArtifact(dir, ROUTES_FILENAME, RoutesReportSchema),
    readArtifact(dir, EDGES_FILENAME, EdgesReportSchema),
    readArtifact(dir, SLICES_FILENAME, SlicesReportSchema),
  ]);
  const skeleton = await readSkeleton(projectRoot);
  const confirmed = await readConfirmedPlan(projectRoot);
  return { census, routes, edges, slices, skeleton, confirmed, gitCommit: census.gitCommit };
}

/** KG table 노드 → DDL 근거 카탈로그 (없으면 빈 배열). related 엣지는 채택 안 함. */
export async function loadKgTableCatalog(projectRoot: string): Promise<KgTableEntry[]> {
  const p = path.join(projectRoot, ".understand-anything", "knowledge-graph.json");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let g: { nodes?: Array<Record<string, unknown>> };
  try {
    g = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: KgTableEntry[] = [];
  for (const n of g.nodes ?? []) {
    if (n.type !== "table" || typeof n.filePath !== "string" || typeof n.name !== "string") continue;
    const lr = Array.isArray(n.lineRange) ? (n.lineRange as number[]) : null;
    out.push({
      name: n.name,
      filePath: n.filePath,
      startLine: typeof lr?.[0] === "number" ? lr[0] : null,
      endLine: typeof lr?.[1] === "number" ? lr[1] : null,
    });
  }
  return out;
}

/** 매퍼 XML(엣지 target)을 읽어 namespace·라인수 인덱스 산출 (IO). */
export async function buildMapperInfo(
  projectRoot: string,
  edges: EdgesReport["edges"],
): Promise<{ mapperNamespaceByPath: Map<string, string>; mapperLineCounts: Map<string, number> }> {
  const targets = new Set<string>();
  for (const e of edges) {
    if (e.kind === "mybatis" || e.kind === "mapper-xml") targets.add(e.target);
  }
  const xmlContents = new Map<string, string>();
  const mapperLineCounts = new Map<string, number>();
  for (const rel of [...targets].sort(cmp)) {
    try {
      const c = await fs.readFile(path.join(projectRoot, rel), "utf-8");
      xmlContents.set(rel, c);
      mapperLineCounts.set(rel, c.split("\n").length);
    } catch {
      /* 읽기 실패한 매퍼는 namespace 미상으로 둔다 (null) */
    }
  }
  const nsIndex = buildMapperNamespaceIndex(xmlContents); // Map<namespace, relPath>
  const mapperNamespaceByPath = new Map<string, string>();
  for (const [ns, rel] of nsIndex) {
    if (!mapperNamespaceByPath.has(rel)) mapperNamespaceByPath.set(rel, ns);
  }
  return { mapperNamespaceByPath, mapperLineCounts };
}

// ── 순수 조립 ─────────────────────────────────────────────────────────────────

function toAffected(r: ReachedFile): AffectedFile {
  return {
    relPath: r.relPath,
    viaKinds: r.viaKinds,
    minDepth: r.minDepth,
    citation: r.citation ? { filePath: r.citation.filePath, line: r.citation.line } : null,
  };
}

export function buildImpactReport(
  inputs: ImpactInputs,
  seeds: readonly ImpactSeed[],
  options: ImpactOptions,
  extras: ImpactExtras,
): ImpactResult {
  const seedsSorted = [...seeds].sort((a, b) => cmp(a.relPath, b.relPath));
  const seedPaths = seedsSorted.map((s) => s.relPath);
  const allowed = new Set<EdgeKind>(options.edgeKinds);

  const revAdj = buildAdjacency(inputs.edges.edges, allowed, "reverse");
  const fwdAdj = buildAdjacency(inputs.edges.edges, allowed, "forward");
  const upstream = reachClosure(seedPaths, revAdj, options.depthCap);
  const downstream = reachClosure(seedPaths, fwdAdj, options.depthCap);

  const upstreamPaths = upstream.map((r) => r.relPath);
  const downstreamPaths = downstream.map((r) => r.relPath);
  const flowSet = new Set<string>([...seedPaths, ...upstreamPaths]);
  const dataSet = new Set<string>([...seedPaths, ...downstreamPaths]);

  const apiRes = computeApiImpact(
    seedPaths,
    upstreamPaths,
    inputs.slices.ownership,
    inputs.routes.routes,
    inputs.routes.batchEntries,
  );
  const persistence = computePersistenceImpact(dataSet, inputs.edges.edges, inputs.census.files, {
    mapperNamespaceByPath: extras.mapperNamespaceByPath,
    mapperLineCounts: extras.mapperLineCounts,
    ownership: inputs.slices.ownership,
    kgTableCatalog: extras.kgTableCatalog,
  });
  const flowRes = computeFlowImpact(
    flowSet,
    inputs.skeleton,
    inputs.slices.ownership,
    inputs.routes.routes,
    inputs.confirmed,
  );

  // 과도전파 투명 보고 (ID5)
  const fanIn = computeFanIn(inputs.edges.edges, allowed);
  const closureFiles = new Set<string>([...upstreamPaths, ...downstreamPaths]);
  const hubNodes = [...closureFiles]
    .filter((f) => (fanIn.get(f) ?? 0) > options.fanInThreshold)
    .map((f) => ({ relPath: f, fanIn: fanIn.get(f)! }))
    .sort((a, b) => cmp(a.relPath, b.relPath));
  // import-only(약신호)로만 도달하는 "숨은" 의존 파일 수 (MED-2). 강신호 기본
  // 필터는 import를 제외하므로, import를 더한 폐포에서 강신호 폐포를 뺀 차가
  // "import 옵트인 시 추가로 보일 파일"이다. import가 이미 활성이면 0(숨김 없음).
  let importOnlyCount: number;
  if (allowed.has("import")) {
    importOnlyCount = 0;
  } else {
    const withImport = new Set<EdgeKind>(allowed);
    withImport.add("import");
    const upI = reachClosure(seedPaths, buildAdjacency(inputs.edges.edges, withImport, "reverse"), options.depthCap);
    const dnI = reachClosure(seedPaths, buildAdjacency(inputs.edges.edges, withImport, "forward"), options.depthCap);
    const hidden = new Set<string>([...upI, ...dnI].map((r) => r.relPath));
    for (const f of closureFiles) hidden.delete(f);
    importOnlyCount = hidden.size;
  }

  // needsReview 집계 + dedup + 정렬
  const langByFile = new Map(inputs.census.files.map((f) => [f.relPath, f.lang]));
  const needsReview: NeedsReviewItem[] = [...flowRes.needsReview];
  for (const d of apiRes.crossCheckDiff) {
    needsReview.push({ ref: d.id, reason: `API 교차검증 불일치 (${d.side})` });
  }
  for (const s of seedsSorted) {
    const lang = langByFile.get(s.relPath);
    if (lang === undefined) {
      needsReview.push({ ref: s.relPath, reason: "시드가 census에 없음 — 경로 확인" });
    } else if (lang !== "java") {
      needsReview.push({
        ref: s.relPath,
        reason: `비-Java 시드(${lang}) — edges가 java 기반이라 역방향 영향 빈약, host 보강 권장`,
      });
    }
    if (s.confidence === "NEEDS_REVIEW") {
      needsReview.push({ ref: s.relPath, reason: "시드 매핑 신뢰도 낮음(host 자연어 추론) — 확인 필요" });
    }
  }
  for (const h of hubNodes) {
    needsReview.push({ ref: h.relPath, reason: `hub(fan-in ${h.fanIn}) 경유 — 영향 과대 추정 가능` });
  }
  // 읽기 실패로 SQL 슬라이스를 만들지 못한 매퍼 (MED-3) — host는 전체 파일 확인.
  const slotMappers = new Set(persistence.tableCandidateSlots.map((s) => s.mapperRelPath));
  for (const m of persistence.mappers) {
    if (!slotMappers.has(m.relPath)) {
      needsReview.push({ ref: m.relPath, reason: "매퍼 파일 읽기 실패 — 테이블 추출 슬라이스 없음(전체 파일 확인)" });
    }
  }
  const seen = new Set<string>();
  const dedupNR = needsReview
    .filter((n) => {
      const k = `${n.ref}|${n.reason}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => cmp(a.ref, b.ref) || cmp(a.reason, b.reason));

  return ImpactResultSchema.parse({
    schemaVersion: 1,
    gitCommit: inputs.gitCommit,
    depthCap: options.depthCap,
    edgeKinds: options.edgeKinds,
    fanInThreshold: options.fanInThreshold,
    seeds: seedsSorted,
    upstream: {
      files: upstream.map(toAffected),
      api: apiRes.api,
      persistence,
      flows: flowRes.flows,
      domains: flowRes.domains,
    },
    downstream: { files: downstream.map(toAffected) },
    overEdges: { hubNodes, importOnlyCount, crossCheckDiff: apiRes.crossCheckDiff },
    needsReview: dedupNR,
  });
}

// ── 검증 준비 (스니펫 채움 = IO) ──────────────────────────────────────────────

// 검증 대상 항목 — 인용 보유분은 기계 검증, 인용 없는 항목(흐름/도메인/SQL/
// 근거 없는 파일)은 uncited로 포함해 groundedPct 분모 편향을 투명화한다(MED-4).
function buildClaimItems(result: ImpactResult): ImpactClaimItem[] {
  const items: ImpactClaimItem[] = [];
  for (const f of result.upstream.files) {
    items.push({ kind: "upstream", ref: f.relPath, text: `상류 영향 파일: ${f.relPath}`, citations: f.citation ? [f.citation] : [] });
  }
  for (const f of result.downstream.files) {
    items.push({ kind: "downstream", ref: f.relPath, text: `하류 의존 파일: ${f.relPath}`, citations: f.citation ? [f.citation] : [] });
  }
  for (const a of result.upstream.api) {
    items.push({ kind: "api", ref: a.id, text: `진입점 영향: ${a.id}`, citations: [{ filePath: a.filePath, line: a.line }] });
  }
  for (const m of result.upstream.persistence.mappers) {
    items.push({ kind: "mapper", ref: m.relPath, text: `영속성 영향: ${m.relPath}`, citations: m.citation ? [m.citation] : [] });
  }
  for (const s of result.upstream.persistence.sqlFiles) {
    items.push({ kind: "sql", ref: s.relPath, text: `영속성(SQL): ${s.relPath}`, citations: [] });
  }
  for (const fl of result.upstream.flows) {
    items.push({ kind: "flow", ref: fl.flowId, text: `흐름 영향: ${fl.flowId}`, citations: [] });
  }
  for (const d of result.upstream.domains) {
    items.push({ kind: "domain", ref: d.domainId ?? d.key, text: `도메인 영향: ${d.key}`, citations: [] });
  }
  return items;
}

/** 인용 라인의 실제 텍스트로 snippet 채움 (루트 밖 경로는 건너뜀 → verify가 path-escape). */
async function fillClaimSnippets(projectRoot: string, items: ImpactClaimItem[]): Promise<void> {
  const rootAbs = path.resolve(projectRoot);
  const cache = new Map<string, string[] | null>();
  for (const item of items) {
    for (const c of item.citations) {
      const abs = path.resolve(projectRoot, c.filePath);
      if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) continue; // path-escape
      let lines = cache.get(abs);
      if (lines === undefined) {
        try {
          lines = (await fs.readFile(abs, "utf-8")).split("\n");
        } catch {
          lines = null;
        }
        cache.set(abs, lines);
      }
      if (lines && c.line >= 1 && c.line <= lines.length) c.snippet = lines[c.line - 1];
    }
  }
}

// ── IO 래퍼 ───────────────────────────────────────────────────────────────────

export async function analyzeImpact(
  projectRoot: string,
  seeds: readonly ImpactSeed[],
  optionsInput?: Partial<ImpactOptions>,
): Promise<AnalyzeImpactResult> {
  const inputs = await loadImpactInputs(projectRoot);
  const options = ImpactOptionsSchema.parse(optionsInput ?? {});
  const kgTableCatalog = await loadKgTableCatalog(projectRoot);
  const { mapperNamespaceByPath, mapperLineCounts } = await buildMapperInfo(
    projectRoot,
    inputs.edges.edges,
  );

  const result = buildImpactReport(inputs, seeds, options, {
    kgTableCatalog,
    mapperNamespaceByPath,
    mapperLineCounts,
  });
  const impactPath = await writeMapArtifact(projectRoot, IMPACT_REPORT_FILENAME, result);

  const items = buildClaimItems(result);
  await fillClaimSnippets(projectRoot, items);
  const verify = await verifyImpactClaims(projectRoot, items, inputs.gitCommit);
  const verifyPath = await writeMapArtifact(projectRoot, IMPACT_VERIFY_FILENAME, verify);

  return { result, verify, impactPath, verifyPath };
}
