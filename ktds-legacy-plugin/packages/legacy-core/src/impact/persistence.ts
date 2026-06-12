import type { CensusFile, FileEdge, FileOwnership } from "../domain-map/types.js";
import type { KgTableEntry, PersistenceImpact } from "./types.js";

// T3 — DB/영속성 영향 (ADR-002 ID3, §1.3 정정). 핵심 의미론: DB 영향은
// DOWNSTREAM(정방향)이다 — 시드가 *건드리는* 매퍼/테이블은 시드가 의존하는
// 하류이지 호출자가 아니다. 따라서 입력 dataImpactSet = 정방향 폐포 ∪ 시드.
//
// 결정론 신호만 엔진이 산출:
//   매퍼 XML = edges.json kind∈(mybatis,mapper-xml)의 target ∩ dataImpactSet
//     (이 간선은 매퍼라서만 존재 — 매퍼 식별이 곧 결정론). namespace는 엔진이
//     buildMapperNamespaceIndex로 채워 넘긴다(있으면).
//   SQL 파일 = census lang=sql ∩ dataImpactSet. ★ .sql은 어떤 간선에도 안 잡혀
//     (edges에 SQL 처리 0건) 사실상 도달성 밖 — note로 명시. 보통 비어 있다.
// 테이블/컬럼은 엔진이 만들지 않는다: tableCandidateSlots(매퍼 SQL 슬라이스
// 위치)를 host(Claude)에게 인용 추출 닻으로 넘기고, KG table 노드(kgTableCatalog)
// 로 추출 테이블명에 schema SQL 근거를 붙인다. KG related 엣지는 채택 금지(약신호).

const MAPPER_EDGE_KINDS = new Set<FileEdge["kind"]>(["mybatis", "mapper-xml"]);

export const PERSISTENCE_NOTE =
  "SQL 파일은 콜체인 간선에 등장하지 않아 도달성 밖입니다(census 인벤토리로만 후보화). " +
  "매퍼 XML이 건드리는 테이블/컬럼은 tableCandidateSlots의 SQL 슬라이스에서 인용 의무로 추출하세요.";

export interface PersistenceInputs {
  /** relPath → MyBatis namespace (엔진이 buildMapperNamespaceIndex로 산출). */
  mapperNamespaceByPath?: Map<string, string>;
  /** relPath → 파일 라인 수 (tableCandidateSlots.endLine; 엔진이 매퍼 읽을 때 계산). */
  mapperLineCounts?: Map<string, number>;
  ownership?: readonly FileOwnership[];
  kgTableCatalog?: readonly KgTableEntry[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computePersistenceImpact(
  /** 정방향(downstream) 폐포 ∪ 시드 — 시드가 도달하는 데이터 계층. */
  dataImpactSet: ReadonlySet<string>,
  edges: readonly FileEdge[],
  census: readonly CensusFile[],
  inputs: PersistenceInputs = {},
): PersistenceImpact {
  const nsByPath = inputs.mapperNamespaceByPath ?? new Map();
  const lineCounts = inputs.mapperLineCounts ?? new Map();
  const ownByFile = new Map((inputs.ownership ?? []).map((o) => [o.relPath, o.owners]));

  // 매퍼 XML: mapper-xml/mybatis 간선의 target ∩ dataImpactSet. 가장 이른
  // 근거 간선(작은 라인)을 인용으로 — filePath=간선 source(매퍼를 부르는 곳).
  const mapperCitation = new Map<string, { filePath: string; line: number }>();
  const mapperPaths = new Set<string>();
  for (const e of edges) {
    if (!MAPPER_EDGE_KINDS.has(e.kind)) continue;
    if (!dataImpactSet.has(e.target)) continue;
    mapperPaths.add(e.target);
    if (e.line !== null) {
      const prev = mapperCitation.get(e.target);
      if (!prev || e.line < prev.line || (e.line === prev.line && e.source < prev.filePath)) {
        mapperCitation.set(e.target, { filePath: e.source, line: e.line });
      }
    }
  }

  const mappers = [...mapperPaths].sort(cmp).map((relPath) => ({
    relPath,
    namespace: nsByPath.get(relPath) ?? null,
    owners: [...(ownByFile.get(relPath) ?? [])].sort(cmp),
    citation: mapperCitation.get(relPath) ?? null,
  }));

  // SQL 파일: census lang=sql ∩ dataImpactSet (도달성 밖이라 보통 비어 있음).
  const sqlFiles = census
    .filter((f) => f.lang === "sql" && dataImpactSet.has(f.relPath))
    .map((f) => ({ relPath: f.relPath, lang: f.lang }))
    .sort((a, b) => cmp(a.relPath, b.relPath));

  // host 인용 추출 닻: 각 영향 매퍼의 전체 SQL 본문 위치. 라인 수 미상(읽기
  // 실패) 매퍼는 [1,1] 가짜 닻을 만들지 않고 슬롯을 생략한다(MED-3) — 엔진이
  // 슬롯 없는 매퍼를 needsReview로 표면화하고 host는 전체 파일을 읽는다.
  const tableCandidateSlots = mappers.flatMap((m) => {
    const endLine = lineCounts.get(m.relPath);
    if (typeof endLine !== "number" || endLine < 1) return [];
    return [{ mapperRelPath: m.relPath, sqlSlice: { filePath: m.relPath, startLine: 1, endLine } }];
  });

  const kgTableCatalog = [...(inputs.kgTableCatalog ?? [])].sort((a, b) => cmp(a.name, b.name));

  return { mappers, sqlFiles, tableCandidateSlots, kgTableCatalog, note: PERSISTENCE_NOTE };
}
