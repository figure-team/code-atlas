import { expect, test } from "vitest";
import type { CensusFile, FileEdge, FileOwnership } from "../domain-map/types.js";
import { computePersistenceImpact, PERSISTENCE_NOTE } from "./persistence.js";

// T3 DoD: 매퍼/비매퍼 구분, SQL 도달성 밖, owners 부착, KG table 매칭,
// tableCandidateSlots 직렬화. dataImpactSet = downstream(정방향) ∪ seeds.

const MAPPER = "src/mapper/AccountMapper.xml";
const SVC = "src/svc/AccountService.java";
const WEBXML = "src/WEB-INF/web.xml";

function census(...rows: Array<[string, string]>): CensusFile[] {
  return rows.map(([relPath, lang]) => ({ relPath, lang }));
}

test("매퍼 XML = mapper-xml 간선 target ∩ dataImpactSet (namespace/owners/citation)", () => {
  const edges: FileEdge[] = [
    { source: SVC, target: MAPPER, kind: "mapper-xml", line: 12 },
    { source: WEBXML, target: WEBXML, kind: "import", line: 1 }, // self-loop류 무시
  ];
  const ownership: FileOwnership[] = [
    { relPath: MAPPER, status: "shared", owners: ["src/web/AccountController.java"] },
  ];
  const r = computePersistenceImpact(new Set([SVC, MAPPER]), edges, census([MAPPER, "xml"]), {
    mapperNamespaceByPath: new Map([[MAPPER, "org.acct.AccountMapper"]]),
    mapperLineCounts: new Map([[MAPPER, 80]]),
    ownership,
  });
  expect(r.mappers).toHaveLength(1);
  expect(r.mappers[0]).toEqual({
    relPath: MAPPER,
    namespace: "org.acct.AccountMapper",
    owners: ["src/web/AccountController.java"],
    citation: { filePath: SVC, line: 12 }, // 매퍼를 부르는 곳(source) 라인
  });
  expect(r.tableCandidateSlots).toEqual([
    { mapperRelPath: MAPPER, sqlSlice: { filePath: MAPPER, startLine: 1, endLine: 80 } },
  ]);
});

test("dataImpactSet 밖 매퍼는 제외 (downstream 폐포에 없으면 영향 아님)", () => {
  const edges: FileEdge[] = [{ source: SVC, target: MAPPER, kind: "mapper-xml", line: 12 }];
  const r = computePersistenceImpact(new Set([SVC]), edges, [], {}); // MAPPER가 set에 없음
  expect(r.mappers).toEqual([]);
});

test("비매퍼 XML(web.xml)은 매퍼로 안 잡힘 (mapper-xml/mybatis 간선 없음)", () => {
  const edges: FileEdge[] = [{ source: SVC, target: WEBXML, kind: "import", line: 3 }];
  const r = computePersistenceImpact(new Set([SVC, WEBXML]), edges, census([WEBXML, "xml"]), {});
  expect(r.mappers).toEqual([]); // import 간선이라 매퍼 아님
});

test("SQL은 도달성 밖 — dataImpactSet에 직접 있을 때만(시드 등) sqlFiles", () => {
  const sql = "src/db/schema.sql";
  const edges: FileEdge[] = [];
  // SQL이 시드라 set에 포함된 경우만 등장
  const inSet = computePersistenceImpact(new Set([sql]), edges, census([sql, "sql"]), {});
  expect(inSet.sqlFiles).toEqual([{ relPath: sql, lang: "sql" }]);
  // set에 없으면 (일반적) 등장 안 함
  const outSet = computePersistenceImpact(new Set(["other.java"]), edges, census([sql, "sql"]), {});
  expect(outSet.sqlFiles).toEqual([]);
  expect(outSet.note).toBe(PERSISTENCE_NOTE);
});

test("mybatis 간선도 매퍼로 인식", () => {
  const edges: FileEdge[] = [{ source: SVC, target: MAPPER, kind: "mybatis", line: 40 }];
  const r = computePersistenceImpact(new Set([SVC, MAPPER]), edges, [], {});
  expect(r.mappers.map((m) => m.relPath)).toEqual([MAPPER]);
});

test("kgTableCatalog 이름순 정렬 + slot endLine 미상 시 1", () => {
  const edges: FileEdge[] = [{ source: SVC, target: MAPPER, kind: "mapper-xml", line: 12 }];
  const r = computePersistenceImpact(new Set([SVC, MAPPER]), edges, [], {
    kgTableCatalog: [
      { name: "ORDERS", filePath: "schema.sql", startLine: 50, endLine: 60 },
      { name: "ACCOUNT", filePath: "schema.sql", startLine: 36, endLine: 51 },
    ],
  });
  expect(r.kgTableCatalog.map((t) => t.name)).toEqual(["ACCOUNT", "ORDERS"]);
  // lineCount 미제공(읽기 실패) → [1,1] 가짜 닻 대신 슬롯 생략 (MED-3)
  expect(r.tableCandidateSlots).toEqual([]);
  expect(r.mappers).toHaveLength(1); // 매퍼 자체는 여전히 영향 목록에 있음
});
