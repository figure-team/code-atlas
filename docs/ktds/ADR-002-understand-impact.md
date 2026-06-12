# ADR-002: /understand-impact — 변경 영향도 분석 (결정론 도달성 + host 운전)

- 상태: **승인 (Accepted)** — T0~T9 구현 완료, N1~N7 충족, 독립 리뷰 2패스(엔진·표면) APPROVE (2026-06-12). 게시(버전 bump·푸시)는 사용자 승인 대기.
- 작성일: 2026-06-12
- 결정 범위: ktds-legacy-plugin (U-A fork 격리 확장)
- 관련: `plan/03_MVP발표(Phase2포함).md` §8 (유스케이스 ③ MVP+), `plan/02_MVP기획안.md` MVP+ 표, ADR-001(/understand-map), 구현 계획 `.omc/plans/understand-impact-tasks.md`

---

## 1. 배경 (Context)

### 1.1 기획 위치

기획 §8(유스케이스 ③)·After 표(§3)는 "변경 영향도 파악: 수동 코드 추적 → `/understand-impact` 자동 분석"을 **MVP+** 기능으로 정의한다. 입력은 자연어("로그인에 간편 로그인 추가") 또는 `--path <파일>`, 분석 범위는 **API 영향 / DB 영향 / 업무 흐름 영향 / 연관 모듈**, 출력은 `docs/09_release/change-impact-analysis.md`(수정 전·후 영향 범위). 검토·승인 상태기계에 속하는 5종 신뢰성 문서(§7)와 **명시적으로 구분**되는 분석 산출물이다.

### 1.2 재료는 이미 있다 (ADR-001 /understand-map 산출물)

/understand-map(Stage-14~18)이 `.spec/map/`에 결정론으로 산출하는 자산이 변경 영향도의 토대다 — 새 정적분석을 만들 필요가 없다(설계 검증으로 확인):

| 자산 | 계약 | 영향도에서의 역할 |
|---|---|---|
| `edges.json` (`FileEdge{source,target,kind,line}`) | source가 target에 의존(FORWARD). kind 9종(import/injection/field-type/ctor-param/extends/implements/impl/mybatis/mapper-xml). `impl`·`mapper-xml`·`mybatis` 간선이 인터페이스·MyBatis XML 경계를 넘김 | **역방향 BFS** = 영향 전파(누가 시드에 의존하나) |
| `slices.json` `ownership[F].owners` | F에 FORWARD로 도달하는 root(진입점 선언 파일), depthCap=12 | F 변경 시 **영향받는 API/배치 진입점** — 이미 계산됨 |
| `routes.json` (`RouteEntry`/`BatchEntry`) | routeId="route:\<METHOD\> \<path\>", filePath=선언 파일=slices root | 영향집합 ∩ route → **API 영향** |
| `skeleton.json` `stepSources` + `flow_step`/`contains_flow` 엣지 | step→파일 사상 + flowId="flow:"+routeId 자연키 | 파일→step→flow→domain 역추적 = **업무 흐름/도메인 영향** |
| KG `table` 노드 + 결정론 `mybatis`/`mapper-xml` 간선 + census lang | table.name→schema SQL filePath:lineRange | **DB 영향** (§1.3 참조) |
| `verify.ts` 인용 검증 + Claim/Confidence + `renderMarkdown`/CLAIMS_FENCE + `logEvent` | 경로실존→lineRange→텍스트일치, [확정(AI)]/[추정]/[확인 필요] 태그 | 영향 주장 **근거율·기계 검증·문서 발행·감사** |

### 1.3 DB 영향 기획 가정 정정 (실측)

기획·초기 메모는 "DB 영향 = KG의 `reads_from`/`writes_to` 엣지"를 가정한다. **이는 실측과 어긋난다:**

- 실제 jpetstore KG(`fixtures/jpetstore/knowledge-graph-ua-real.json`, 276노드)에 **`reads_from`/`writes_to` 엣지 0건**. KG가 emit하는 엣지: migrates/related/depends_on/contains/calls/exports/inherits/tested_by/contains_flow/flow_step/cross_domain.
- 기존 `buildDbSpec`(doc-generator)도 `reads_from`/`writes_to`에 의존 → **실 KG에서 05_db-spec의 "데이터 접근" 섹션은 비어 있다**(영향도가 따르면 안 되는 패턴).
- 다만 **매퍼→테이블 연결 자체가 부재한 것은 아니다**: KG에 `related` 엣지로 13건 존재(`config:Mapper.xml → table:`). 단 `related`는 U-A LLM 산문 엣지(약신호, read/write 미구분·방향성 무의미·재실행 비결정)라 **결정론 사실 근거로 채택 불가**.

→ DB 영향은 (a) 결정론 `mybatis`/`mapper-xml` 간선 + census lang=sql/xml/jsp로 **"영향받는 매퍼/SQL 파일"까지만** 산출하고, (b) 테이블/컬럼은 host가 매퍼 슬라이스 SQL 본문에서 **인용 의무로 추출**(KG table 노드 filePath/lineRange를 환각 방지 닻으로), `related`는 후보 좁히기 약힌트로만.

---

## 2. 결정 (Decision)

**ID1.** ktds-legacy-plugin에 신규 명령 **`/understand-impact`**를 신설한다. 모든 신규 코드는 `packages/legacy-core/src/impact/` — **U-A 원본 무수정(A1/M7) 유지**. 기존 파일 수정은 두 곳으로 제한: `legacy-core/src/types.ts`에 감사 이벤트 `IMPACT_ANALYZED` 1줄, `doc-generator/index.ts`의 `renderMarkdown`에 하위호환 `statusLine?` 파라미터(기본값=현행 문자열 → 5종 문서 골든 스냅샷 불변). 둘 다 ktds 자체 코드이며 U-A가 아니다.

**ID2.** 출력 `change-impact-analysis.md`는 **읽기전용 분석 산출물**이다 — `registerDraft`를 호출하지 않아 doc-state 상태기계(DRAFT→검토→승인) 밖에 둔다. 근거: (a) 기획 §8이 MVP+ 분석으로 분류(5종 신뢰성 흐름과 구분), (b) 영향 추정은 본질상 INFERRED(역도달성 추정) 다수라 `approveDoc` 미확정 게이트·`computeInferredRatio` 차단 게이트에 걸려 승인이 비현실적. 검토·확정이 필요하면 Phase 2. (사용자 확정, 2026-06-12.)

**ID3.** 파이프라인 = **결정론 엔진 + host 운전**. 결정론 경계는 ADR-001의 "구조는 엔진, 산문은 host" 원칙을 답습한다:

| 단계 | 담당 | 내용 |
|---|---|---|
| 시드 매핑 | host(Claude) | 자연어 변경요청 → 시드 파일 집합. routes/domain-graph/census 카탈로그 사용 → **사용자 확인 게이트**(understand-map confirm 패턴) → `--path`. 엔진은 자연어를 절대 받지 않는다(`relPath[]`만) |
| 역/정 도달성 | 엔진 | `edges.json`으로 reverse adjacency build → 시드에서 역BFS = **upstream(영향받는 호출자)**, 정BFS = **downstream(의존 협력자, 보조)**. depthCap=12 대칭. edge-kind 기본=강신호-only, import 옵트인 |
| API 영향 | 엔진 | `ownership[seed].owners`→route/batch 조인(1차, 캡일관) + REVERSE∩route.filePath(2차 교차) → diff는 NEEDS_REVIEW |
| DB/영속성 영향 | 엔진+host | 엔진: 영향집합 ∩ {mybatis/mapper-xml target} ∪ {census sql/xml/jsp} → 영향 매퍼/SQL 파일 + `tableCandidateSlots`(빈 슬롯+SQL 슬라이스 위치). host: 슬라이스 SQL에서 테이블/컬럼 인용 추출 |
| 업무흐름/도메인 영향 | 엔진 | `stepSources`로 파일→step, `flow_step`/`contains_flow` 엣지 REVERSE로 step→flow→domain. flowId↔routeId 꼬리표 보존 조인. skeleton 부재/cap 절단은 `ownership` 폴백 합집합 |
| 근거 검증 | 엔진 | 모든 사실 주장의 `파일:라인` 인용을 verify.ts 패턴(경로실존→lineRange→텍스트일치→trivial 게이팅)으로 검증, per-doc 근거율 산출 |
| 발행 | 엔진→host | 엔진은 `impact.json`(.spec/map/)만 결정론 발행. `change-impact-analysis.md`는 host 보강(테이블 인용·산문) 후 별도 단계에서 `docs/09_release/`에 발행 |

**ID4.** **재사용 원칙**: 엔진은 `.spec/map/` 영속 산출물(또는 `scanDomainMap` 반환값)을 입력으로 받고 **재스캔·재파스 0회**(M4 예산). 모든 도달집합·조인·역추적·인용은 순수함수 + 정렬·무타임스탬프로 **impact.json byte-diff=0**(M1류). host 비결정(자연어 매핑·테이블 추출·산문)은 ImpactResult에 들어가지 않고 발행 단계 슬롯에만 합류 → 엔진 결정론 불변(doc-generator prose 경계와 동일 원리).

**ID5.** **과도전파 제어**: 역방향은 hub 파일(공용 유틸/예외/상수)·import 노이즈·mybatis "ANY dotted literal" false edge로 영향집합이 폭발할 수 있다. 엔진은 (a) edge-kind 필터(강신호 기본), (b) reverse fan-in 임계 초과 노드 NEEDS_REVIEW 강등, (c) shared 파일 경유 경고, (d) `overEdges{hubNodes,importOnlyEdges}` 투명 보고를 내장한다. 정확도 하네스는 **precision+recall 양축**(recall만 보면 hub 위양성이 은폐됨).

**ID6.** **검증 복제**: verify.ts의 `normalize`/`isTrivialSnippet`/`verifyCitation`은 module-private이고 입력이 `DomainFill[]`에 강결합이다. U-A·domain-map 무수정 규율(verify.ts 수정 회피)을 위해 `impact/verify.ts`로 **복제**하고 **골든 동치 테스트**로 원본과 status 일치를 고정한다(복제 드리프트를 테스트로 방어). 향후 `verifyCitation` export 단일화는 Phase 2 후보로 기록.

**ID7.** **graceful 결손**: `scanDomainMap`은 confirm 게이트 미통과 시 `confirmed:null`·`skeleton:null`을 반환한다. flow-impact는 skeleton 부재 시 **throw하지 않고** `ownership`-only 폴백 + 도메인명 NEEDS_REVIEW로 강등한다("skeleton 부재=정상 결손"). 비-Java 시드(JSP/TS/web.xml)는 `collectEdges`가 javaFacts 기반이라 역방향이 빈약 → 자동 NEEDS_REVIEW 강등 + host 보강 요청.

**ID8.** **CLI/SKILL 표면**: `scripts/understand-impact.mjs`(understand-map.mjs 골격: 비-TTY 안전·한국어·EPIPE·ensureBuilt 동적 import). 서브커맨드 `seeds`(시드 매핑 카탈로그)/`analyze`(--path 다중)/`status`. 비-TTY 임의 분석 금지(시드 빈집합 fail-closed). `skills/understand-impact/SKILL.md`는 자연어→시드→확인 게이트→DB 인용 의무→과도전파 투명 보고를 명세.

---

## 3. 기각 대안 (Alternatives Considered)

| 대안 | 기각 사유 |
|---|---|
| KG `reads_from`/`writes_to`로 DB 영향 | 실 KG에 0건(실측). buildDbSpec이 이미 이 함정에 빠짐 → 영속성 영향은 결정론 `mybatis`/`mapper-xml` 간선 + census로 |
| KG `related` 엣지를 DB 영향 사실로 | LLM 산문 약신호(read/write 미구분·비결정) — 후보 좁히기 힌트로만 |
| 엔진이 자연어 입력 직접 수용 | 자연어→파일 매핑은 본질상 모호 — host가 카탈로그로 매핑 + 사용자 확인 게이트(프로젝트 "산문=host" 규율) |
| `ownership`만으로 영향 파일 산출 | ownership=진입점(root) 단위라 중간 상류 파일 누락 → edges 역BFS로 전체 파일집합 별도 계산 |
| 영향도를 검토·승인 상태기계에 편입 | INFERRED 다수로 approve 게이트 비현실적 + 기획상 분석 산출물(ID2) |
| `change-impact-analysis.md`를 엔진이 직접 발행 | host 테이블 인용·산문 전 빈 슬롯 .md가 먼저 나가는 순서 모순 → 엔진은 impact.json만, .md는 보강 후 |
| recall 단일축 정확도 게이트 | 역방향은 hub로 recall 100% 위양성 은폐 → precision 양축 필수 |
| verify.ts에 verifyCitation export(1줄) | 더 깔끔하나 domain-map 수정 = 격리 규율과 충돌 → 복제+골든(Phase 2 재평가) |

---

## 4. 결과 (Consequences)

**얻는 것**
- 변경 영향(API/DB/흐름/연관모듈)이 **결정론 정적분석**으로 산출 → 근거율의 최대 지분이 LLM을 거치지 않음(A3 정합)
- /understand-map 산출물 위에서 **재스캔 0회** → M4 예산 보존, impact.json byte-diff=0(M1류)
- 영향 주장이 verify.ts 패턴으로 기계 검증 → 환각 차단(M3 정합)
- 출력이 5종 문서와 동일 태그·펜스·근거 형식(renderMarkdown 재사용) → 일관성·감사 호환

**감수하는 것**
- DB 테이블/컬럼 단위 영향은 host 인용에 의존(동적 SQL·`${}`·`<include>` 조각에서 오탐·누락 → NEEDS_REVIEW)
- 역방향 과도전파(hub) 리스크 — 제어 장치(ID5)로 완화하나 완전 제거 불가
- 비-Java 시드 빈약(edges가 javaFacts 기반) → NEEDS_REVIEW 강등
- verify 로직 복제 유지보수(골든 테스트로 방어)

**변하지 않는 것**
- /understand는 4종 문서, /understand-map은 03_feature-spec/domain-graph의 원천 — /understand-impact는 둘 다 대체하지 않고 그 산출물을 **소비만** 한다

---

## 5. 수용 기준 (이 ADR 추가분 — 기존 A/M 기준 연동)

| ID | 기준 | 검증 |
|---|---|---|
| N1 | 동일 시드 + 동일 commit + 동일 `.spec/map/`에서 2회 실행 → `impact.json`(+ .md claim 영역) byte-diff=0 | golden/determinism 테스트 (M1 확장) |
| N2 | 영향 주장 인용 실존율 100%(기계 검증 통과분 기준), per-doc 근거율 리포트 산출 | verifyImpactClaims 리포트 (M3 정합) |
| N3 | 역방향 도달성 정확도 — 실 jpetstore에서 seed→mustAffect recall + mustNotAffect precision(hub 과도전파 게이트) | impact-recall 하네스 |
| N4 | API/배치·DB/영속성·흐름/도메인 4축 영향이 각 결정론 경로로 산출(인용 동봉) | 단위 테스트 4종 |
| N5 | skeleton/confirmed 부재 시 throw 없이 ownership 폴백 + NEEDS_REVIEW 강등 | flow-impact 테스트 |
| N6 | 비-TTY 임의 분석 금지(시드 빈집합 fail-closed), 한국어 출력, EPIPE 안전 | CLI smoke |
| N7 | U-A 원본 diff 0, ktds 기존 파일 수정 ≤2곳(types.ts 1줄 + renderMarkdown statusLine) | A1 / diff 검토 |

---

## 6. 결정된 정책 (사용자 + 합리적 기본값)

1. **출력 위상** = 읽기전용 분석물(ID2, 사용자 확정).
2. **영향 방향** = upstream 1급 + downstream 보조 섹션(사용자 확정).
3. **renderMarkdown 헤더** = `statusLine?` 파라미터 추가(하위호환 기본값). ktds 자체 코드, 5종 골든 불변.
4. **edge-kind 기본** = 강신호-only(injection/ctor-param/impl/mybatis/mapper-xml + extends/implements), import는 옵트인.
5. **근거율** = 측정·보고만(하드 차단 없음 — 영향 추정은 INFERRED 다수).
6. **실측 정확도** = 실제 `~/projects/ktds/jpetstore`(.spec/map 보유)로 T9 검증.

## 7. 미결 (Open Questions)

1. `verifyCitation` export 단일화(복제 제거) Phase 2 이관 시점.
2. downstream 보조 섹션의 장기 유용성 — 실프로젝트 피드백 후 유지/축소 재평가.
3. 동적 SQL(`${}`/`<include>`) 테이블 추출 보강 — 대상 고객 코드 확보 후.

## 부록 A. 대시보드 오버레이 + SR 워크벤치 (2026-06-12 중간 점검 후속, T10/T11)

중간 점검(ultracode 워크플로 + 적대 비평)에서 확정한 두 보완 — 주 사용자를 PL로 명문화하며 식별된 "호출 표면" 갭 중 최저비용 2건.

### A.1 대시보드 오버레이 (T10 — U-A 완전 무수정)

`analyze`가 impact 결과를 U-A가 이미 소비하는 입력 계약 **`.understand-anything/diff-overlay.json`**(understand-diff SKILL.md §8)으로 변환 발행한다. 서버 엔드포인트(vite `/diff-overlay.json`)·로더(App.tsx — 배열 존재 + `changedNodeIds.length>0`만 검사)·렌더(CustomNode ring/fade, DiffToggle)가 전부 기성품이므로 **U-A 코드·스킬·산출물 무수정**이다.

- **집합 매핑**: `changedNodeIds`=시드, `affectedNodeIds`=(상류∪하류)−시드(계약의 "excluding changedNodeIds" 준수, relPath 기준 dedup).
- **노드 조인**: `file:<relPath>` 직조인 → type=file → type=config(매퍼 XML 실측 패턴) → id 사전순. **대표 1노드/파일**(범례 카운트=파일 수 유지). KG `filePath`가 절대경로인 프로젝트 대응으로 projectRoot 상대화 정규화를 변환기에 내장 — 서버 normalizeGraphPath와 방향 동일하되 **더 엄격**(dot-segment 거부, 분리자 경계 요구; 미조인은 unresolved 표면화라 fail-closed가 오답보다 낫다). 미조인은 `ktdsImpact.unresolved`로 echo(은폐 금지).
- **결정론 경계**: 순수 변환(buildDiffOverlay)은 결정론, `generatedAt`만 IO 경계에서 스탬프(U-A 계약 필드, App.tsx 미사용, `.spec/map` 산출물 아님).
- **경합**: `/understand-diff`와 같은 파일 — `baseBranch:"ktds-impact"` 마커로 출처 판별, 타 출처 파일은 `.bak` 보존 후 덮어씀(last-writer-wins 완화).
- **한계(수용)**: diff 의미론 2분류뿐 — 시드/상류/하류 3색·깊이·API/DB 표·근거율 게이지는 표현 불가. 그 요구가 확정되면 fork 수정(C안)으로 상승하되 본 조인 로직은 재사용. 오버레이는 구조 뷰 전용(도메인/지식 뷰 미표시), dev 서버 전제. 대시보드 스키마 검증에서 drop된 노드는 범례 카운트에만 남고 하이라이트되지 않을 수 있다(오버레이는 디스크 KG 실존 id만 내보내므로 통상 불발생).

### A.2 SR 워크벤치 (T11 — `--sr` 보관 + 집계)

- `analyze --sr <SR-ID>` → 분석 사본(impact.json+verify+보고서)을 `.spec/impact/<SR-ID>/`에 보관(원자 쓰기). `.spec/map/impact.json`(최신 1건)·`docs/09_release/`(최신 보고서) 의미론 불변 — 보관본은 항상 사본. `status --list`로 이력 조회(손상 보관본 valid:false 표면화). SR ID는 디렉터리명 안전성 fail-closed(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`).
- 보고서에 **영향 규모 집계** 섹션(공수 산정 입력): 도메인×상류/하류·언어×상류/하류 파일 수. 도메인 귀속=**슬라이스 ownership 기반**(owner root 파일→confirmed 도메인; 루트 자신·단일 도메인=해당 도메인, 복수 도메인=`(공용)`, 미도달·확정 밖=`(미분류)`, census 밖 lang=`(census 밖)`) — ConfirmedDomain.roots는 디렉터리가 아니라 엔트리 **파일 경로**라 prefix 매칭은 전건 미분류로 쏠리는 오답(독립 리뷰 critical로 검출·정정). ownership·roots 모두 정렬 산출물이라 결정론. 집계는 claims가 아니라 prose(파생 수치 — 확정 대상 아님).
- **수반 수정**: engine `buildClaimItems`가 인용을 **사본**으로 담도록 정정 — 기존엔 result의 citation 참조 공유로 `fillClaimSnippets`가 in-memory result를 변이했고(디스크 정본은 변이 전 기록이라 무사), SR 보관 직렬화에서 "앵커만" 계약 위반으로 표면화. 회귀 테스트: 반환 result의 stableJson == 디스크 정본.
