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
