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
