# 장애 대응 가이드 — ktds Legacy 문서 자동화

실제 코드가 내는 메시지 기준. 모든 실패는 감사 로그(`.spec/audit/*.jsonl`)에 남는다.

---

## 1. 문서 생성 중단 (RUN_ABORTED)

### `RUN_ABORTED: <doc>: inferred ratio N% exceeds block 60%`
- **원인:** 해당 문서의 `[추정]` 비율이 차단 임계값(`inferredRatioBlockThreshold`, 기본 0.6) 초과. 분석 근거가 부족하거나 추론이 과다.
- **대응:**
  1. 해당 문서를 열어 `[추정]` 항목 확인 — 근거를 붙일 수 있는지 검토.
  2. **tech-stack이 자주 걸림:** 언어/프레임워크가 근거 없는 추정이면 비율 급등 → `understanding.config.json`의 `configFiles`에 빌드 파일(`pom.xml`, `build.gradle`)을 넣어 근거화(→ `[확정(AI)]`).
  3. U-A 분석을 보강(`/understand --full`)해 코드 근거 노드를 늘린다.
  4. 정책상 허용 가능하면 `inferredRatioBlockThreshold` 상향(신중히).

### `RUN_ABORTED: <doc>: CONFIRMED_AI without evidence (RETURNED)`
- **원인:** `[확정(AI)]`인데 근거(file:line)가 없는 claim 발생(근거 계약 위반).
- **대응:** U-A 그래프 품질 문제일 가능성 — 해당 노드에 `filePath`가 없는지 확인. 정상적으로는 doc-generator가 근거 없는 항목을 `[추정]`으로 격하하므로, 이 오류가 나면 입력 그래프 점검.

> RUN_ABORTED 시 staging은 통째로 폐기되어 **기존 문서는 변경되지 않는다.** 원인 해소 후 재실행.

---

## 2. 승인/상태 오류

### `[doc-state] illegal transition X -> Y`
- **원인:** 허용되지 않은 상태 전이. 가장 흔한 경우: DRAFT를 바로 `approve`(반드시 `review`로 UNDER_REVIEW 경유).
- **대응:** `review --doc <f>` 먼저 → `approve --doc <f> --by <handle>`. 허용 경로: DRAFT→UNDER_REVIEW→APPROVED, UNDER_REVIEW→RETURNED→DRAFT.

### `[doc-state] doc-status.json is corrupt (invalid JSON)` / `is malformed (expected an object map)`
### `[approval] approvals.json is corrupt` / `is malformed (expected an array)`
- **원인:** 크래시·수기 편집으로 상태/승인 파일 손상.
- **대응:** `.spec/doc-status.json` 또는 `.spec/approvals.json`을 백업 후 점검. 복구 불가 시 해당 파일 삭제(문서는 기본 DRAFT로 재인식) 후 재검토. 감사 로그는 별도 보존됨.

---

## 3. 동시 실행 / 잠금

### `[lock] analysis already running (live pid N, since <시각>)`
- **원인:** 다른 분석이 진행 중(같은 워크스테이션). `.spec/.analysis.lock` 보유.
- **대응:** 진행 중 작업 완료 대기. 정말 멈춰 있다면 해당 PID 종료 확인 후 재시도(죽은 PID면 자동으로 stale 처리됨).

### 감사에 `STALE_LOCK_REMOVED`
- **의미:** 죽은 PID의 잠금을 자동 정리하고 진행했다는 정상 복구 기록. 조치 불필요.

> MVP 잠금은 **단일 워크스테이션/단일 파일시스템 전용**(분산 락 미지원).

---

## 4. U-A 그래프 / 스키마 문제

### `[kg-reader] malformed knowledge-graph: expected { version: string, nodes: [], edges: [] }`
- **원인:** `.understand-anything/knowledge-graph.json`이 없거나 손상/형식 불일치.
- **대응:** U-A `/understand <root>`를 먼저 실행했는지 확인. 경로: `<root>/.understand-anything/knowledge-graph.json`.

### `[kg-reader] node "X" missing required fields (summary:string, tags:string[])`
- **원인:** U-A 출력이 스키마와 어긋남(드리프트 또는 손상).
- **대응:** `/understand --full`로 재생성. 반복되면 U-A 버전 확인 + `docs/ktds/UA_BASELINE.md` 대조.

### `[kg-reader] fingerprint drift: unknown node types [...]` / `unknown edge types [...]` / `key fields absent`
- **원인:** U-A 업그레이드로 스키마가 baseline에서 벗어남(조용히 통과시키지 않고 경고).
- **대응:** `docs/ktds/UA_BASELINE.md`를 새 U-A 소스 기준으로 갱신하고, 필요 시 kg-reader 매핑(§2.3)과 ADR 반영. [`UPSTREAM_MERGE.md`](./UPSTREAM_MERGE.md) 절차 참조.

### `[kg-reader] version guard: graph.version="X" outside supported ["1.0.0"]`
- **원인:** 그래프 데이터 버전이 `supportedSchemaVersions` 밖.
- **대응:** 호환 확인 후 `understanding.config.json`의 `supportedSchemaVersions`에 추가하거나, 지원 버전의 U-A로 재생성.

---

## 4-1. 도메인 맵 (/understand-map)

### `skeleton.json 없음 — 먼저 scan + 도메인 경계 확정(confirm)을 실행하세요` (emit 시)
- **원인:** ✋게이트 미통과 — `domain-plan.confirmed.json`이 없어 skeleton이 생성되지 않음.
- **대응:** `confirm`(TTY 인터랙티브) 또는 `confirm --auto-approve --by <핸들>` 후 재시도.

### `⚠ 확정 플랜 드리프트 감지 — 재확정(confirm) 권장` (scan 시)
- **원인:** 게이트 확정 이후 코드가 변해 엔트리(루트)가 생기거나 사라짐.
- **대응:** 표시된 새/사라진 루트를 확인하고 재확정. 기존 확정을 갈아엎으려면 `.spec/map/domain-plan.confirmed.json` 삭제 후 confirm.

### `✗ fill 스키마 위반 [key]` / `✗ 구조 위반 기각 [domainId] <ref>` (emit 시)
- **원인:** fill이 인용 의무(citations≥1, snippet≥8자)를 어겼거나, 모르는/타 도메인의 flow·step ID를 건드림(구조는 read-only).
- **대응:** 해당 도메인의 `fill/<key>.json`만 계약대로 재작성 후 emit 재실행(멱등 — 다른 도메인은 영향 없음).

### 근거율이 낮음 / `[확인 필요]` 강등 다수 (verify-report.json)
- **원인:** 인용 실패 — `no-file`(경로 오타/환각), `line-out-of-range`, `text-mismatch`(라인 내용 불일치 — 코드가 변했거나 스니펫 조작), `trivial-snippet`(`") {"` 같은 무의미 토막), `path-escape`(프로젝트 밖 경로).
- **대응:** `.spec/map/verify-report.json`에서 status별 원인 확인 → fill의 인용을 번들 소스 슬라이스의 실제 라인으로 수정. `⚠ skeleton이 옛 commit 산물` 경고가 함께 떴다면 scan부터 재실행(라인 이동).

### `[understand-docs] 도메인 분석이 knowledge-graph보다 오래됨` / `생성 commit이 KG commit과 다름`
- **원인:** domain-graph emit 이후 `/understand` 재실행 또는 코드 변경 (freshness 대조 — 구조 투영 기준이라 단순 재실행로는 오발하지 않음).
- **대응:** 차단 아님(문서는 생성됨). 최신화하려면 `scan` → (드리프트 시 재확정) → `emit` 재실행.

---

## 4-2. 변경 영향도 (/understand-impact)

### `census.json 없음 — 먼저 /understand-map scan을 실행하세요(.spec/map/ 산출물 필요)` (analyze/seeds 시, exit 2)
- **원인:** `/understand-impact`는 `/understand-map scan`이 만든 `.spec/map/` 산출물(census·routes·edges·slices)을 입력으로 쓴다. 그게 없음.
- **대응:** `node …/understand-map.mjs <root> scan` 먼저 실행. 흐름/도메인 영향까지 보려면 `confirm`까지(아니면 흐름/도메인은 `[확인 필요]` 강등).

### `시드(--path)가 없습니다. 임의 분석을 하지 않습니다.` (analyze 시)
- **원인:** fail-closed — 엔진은 자연어를 받지 않고 `--path` 파일 집합만 받는다. 시드 미지정.
- **대응:** `seeds` 카탈로그로 변경 대상 파일을 고른 뒤 `analyze --path <파일> [--path …]`. 슬래시 사용 시 Claude가 자연어→시드 매핑 + ✋확인 게이트를 거친다(SKILL.md). (입력 자체가 없으면 위 census 오류로 exit 2.)

### 흐름/도메인 영향이 비거나 `[확인 필요]` 다수
- **원인:** `/understand-map confirm`(도메인 경계 확정) 미통과 → skeleton/도메인명 없음. 또는 비-Java 시드(JSP/TS/web.xml — edges가 java 기반이라 역방향 빈약).
- **대응:** 정상 동작(graceful 강등) — 확정 도메인이 필요하면 `/understand-map confirm`. 비-Java 시드는 host가 슬라이스로 보강. needsReview 항목을 그대로 보고에 노출한다.

### API 영향이 `[추정]`/`[확인 필요]`로 나옴 (crossCheckDiff)
- **원인:** ownership(전 간선·캡일관) 1차와 reverse(강신호 필터) 2차가 불일치 — 약신호(import)로만 닿거나 cap 절단 차이. 위양성/위음성 경계.
- **대응:** `both`(양쪽 일치)만 `[확정(AI)]`. 단일 신호는 의도적 표면화이니 `impact.json`의 `overEdges.crossCheckDiff`로 확인. import 신호까지 보려면 `overEdges.importOnlyCount`(숨은 의존 수) 참고.

### DB 매퍼는 잡히는데 테이블/컬럼이 없음
- **원인:** 정상 — 엔진은 영향 매퍼 XML까지만 결정론 산출(실 KG에 reads_from/writes_to 0건). 테이블/컬럼은 host 인용 추출 몫.
- **대응:** `impact.json`의 `tableCandidateSlots`(매퍼 SQL 슬라이스 위치) + `kgTableCatalog`(테이블명→DDL 라인)로 host가 인용 추출. 동적 SQL(`${}`·`<include>`)은 `[확인 필요]`. `매퍼 파일 읽기 실패` needsReview가 뜨면 전체 파일 확인.

### 대시보드에 영향도(오버레이)가 안 보임
- **원인 후보:** ① analyze 시점에 KG 부재 → 오버레이 생략(`대시보드 영향도 오버레이: 생략` 출력). ② 시드가 KG에 미조인 → 시드 0이면 토글이 비활성(`주의: 시드가 KG에 매칭되지 않아…` 경고). ③ 토글이 꺼져 있거나 **다른 채널이 활성** — 예측은 '영향도' 토글(`i`), 실측은 Diff 토글(`d`), 둘은 배타적이고 둘 다 있으면 최신 분석이 자동 활성. ④ 구버전(≤0.8.0) 잔재 — 예측이 diff-overlay.json에 쓰이던 시절 파일은 analyze 재실행 시 자동 정리.
- **대응:** analyze 출력의 `대시보드 … 오버레이:` 줄에서 시드/영향/미조인 수 확인. `KG 미조인 N`이 뜨면 `/understand` 분석 범위가 영향 파일을 포함하는지 확인(`impact-overlay.json`의 `ktdsImpact.unresolved`에 사유). 브라우저는 새로고침.

### 도메인 뷰에 일부 영향 파일이 안 나옴
- **원인:** 정상 — 도메인 뷰는 step(라우트 체인 파일) 입도라 **체인에 등장하는 파일만** 배지가 붙는다. 체인 밖 유틸/협력자는 표시 대상이 아님.
- **대응:** 도달 폐포 전체는 구조 뷰(노드 배지·컨테이너 칩)와 보고서(`change-impact-analysis.md`)가 정본.

### `잘못된 SR ID` / `--sr 값 누락` (analyze 시)
- **원인:** fail-closed — SR ID는 디렉터리명이 되므로 영숫자 시작·영숫자/점/하이픈/밑줄·100자 이내만 허용. `--sr`만 쓰고 값을 빠뜨려도 침묵 무보관 대신 에러를 낸다.
- **대응:** `--sr SR-2026-0612-001` 형식으로 지정. 보관 확인은 `status --list`(엔진이 만든 SR ID 형식 디렉터리만 표시, 손상 보관본은 `[손상]`으로 표면화).

## 4-3. 변경분 실측 리뷰 (/understand-review)

### `git diff 실패 (base=…) — git 저장소가 아니거나 ref가 유효하지 않습니다` (exit 2)
- **원인:** fail-closed — 실측 리뷰는 git이 변경 사실의 유일한 결정론 소스다. 비-git(SVN 등) 프로젝트거나 `--base` ref 오타.
- **대응:** git 프로젝트에서만 사용(예측 분석 §2-2는 비-git도 가능). base는 `git rev-parse <ref>`로 유효성 확인.

### `base를 정할 수 없습니다 — map 산출물에 gitCommit이 없습니다` (exit 2)
- **원인:** 마지막 map 스캔이 git 밖에서 실행돼 census.gitCommit이 null — base 기본값을 만들 수 없음.
- **대응:** `--base <ref>`를 명시하거나, git 저장소 안에서 `/understand-map scan`을 재실행.

### 커밋한 뒤 다시 돌리니 `변경 없음`이 나옴
- **원인:** 리뷰 실행이 map을 자동 재스캔하면서 census.gitCommit(기본 base)이 현재 HEAD로 이동 — 커밋된 변경은 "base 이후 변경"이 아니게 된다.
- **대응:** 커밋된 변경을 리뷰할 땐 `--base <ref>`를 명시(예: `--base origin/main`, `--base HEAD~1`). 미커밋 워크플로(주 용도)에서는 영향 없음. 참고: untracked 신규 파일도 변경분에 자동 포함된다(`git add` 불필요).

### 예측 대조가 "대조 생략"으로 나옴
- **원인:** 해당 SR의 사전 예측 보관본(`.spec/impact/<SR-ID>/impact.json`)이 없거나 손상.
- **대응:** 정상 동작(graceful) — 사전 예측 없이 리뷰만 한 경우다. 대조를 원하면 변경 전에 `/understand-impact analyze --sr <SR-ID>`로 예측을 먼저 보관해 두는 운영 습관을 들일 것.

---

## 4-4. 세분화 위키 (/understand-docs wiki, ADR-004)

### 대시보드에 "문서" 토글이 안 보임
- **원인:** 대시보드를 `docs/`가 아니라 **프로젝트 루트**로 띄워야 한다(`GRAPH_DIR=<projectRoot>`). 위키 그래프는 루트 `.understand-anything/wiki-graph.json`에 있다. 또는 위키 미생성.
- **대응:** `… understand-docs.mjs <root> wiki`로 생성 후 `GRAPH_DIR=<root>`로 기동. 토글은 `wiki-graph.json`이 로드돼야 나타난다.

### `/understand` 다시 돌렸더니 "문서" 토글이 사라짐
- **원인:** `/understand`가 루트 `.understand-anything/`를 재생성하며 `wiki-graph.json`을 지운다(도메인 그래프와 동일 수명).
- **대응:** `… understand-docs.mjs <root> wiki` 재실행(멱등). 코드/도메인 그래프 갱신 후 위키도 재생성하는 습관.

### step 노트가 너무 많음(대규모 시스템)
- **원인:** `--steps`는 코드량 비례 폭증 구간(jpetstore 32 → 대규모 수천).
- **대응:** 기본(4계층, step 제외)으로 운영. step은 특정 흐름 추적이 필요할 때만 `--steps`.

### 문서 모드 본문이 raw 텍스트로 보이거나 잘림
- **원인:** 구버전 대시보드(ID9 fork 이전). 본문 마크다운 렌더+전체 본문은 understand-anything 2.8.0+ 필요.
- **대응:** 대시보드 재빌드/재설치(2.8.0+).

### `--no-wiki`인데 위키 파일이 남아 있음
- **원인:** `--no-wiki`는 위키를 **만들지 않을** 뿐 기존 산출물을 삭제하지 않는다(5종 골든 바이트 동일만 보장).
- **대응:** 정상. 위키를 지우려면 `docs/{feature,api,table}`·`docs/index.md`·루트 `.understand-anything/wiki-graph.json`을 수동 삭제.

---

## 5. 내보내기 / 빌드

- **HTML이 비어 보임/항목 없음:** 해당 노드 타입이 그래프에 없을 수 있음. **feature-spec(03)이 비면 `/understand-map`을 실행**하라 — scan→✋경계 확정→bundle→LLM 채움→emit으로 `domain-graph.json`이 생성되고, `/understand-docs`가 자동 병합한다(미실행 시 생성 단계에서 안내 경고가 뜬다). domain-graph가 KG보다 오래되면 freshness 경고가 뜬다 → `emit` 재실행.
- **빌드 실패:** `corepack prepare pnpm@10.6.2 --activate` 후 `pnpm install && pnpm -r build`. Node 22 권장.

---

## 6. 점검 순서 (요약)

1. 감사 로그 확인: `audit --list` / `.spec/audit/*.jsonl`
2. 상태 확인: `.spec/doc-status.json`
3. 입력 그래프 확인: `.understand-anything/knowledge-graph.json` 존재·버전
4. 재현: 원인 해소 후 재생성(실패해도 기존 문서 불변)

> 보안 관련 오류(secret/PII·중계·하향 override)는 **Phase 2**에서 추가된다.
