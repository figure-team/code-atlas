# 운영자 매뉴얼 — ktds Legacy 문서 자동화

> ⚠️ **MVP는 비민감 샘플 전용.** 보안 게이트가 없으므로 실제 고객 코드 분석 금지(Phase 2 선행 필요).

## 0. 전체 흐름 (한눈에)

```
U-A /understand                → .understand-anything/knowledge-graph.json
  → ktds /understand-init      → understanding.config.json + .spec/
  → ktds /understand-map       → .understand-anything/domain-graph.json (03 기능명세의 공급원)
      scan                     → census/라우트/콜체인/도달성/도메인 후보 (.spec/map/, 결정론)
      plan · confirm           → ✋ 도메인 경계 확정 게이트 (영속 + MAP_PLAN_CONFIRMED 감사)
      bundle → (LLM 채움) → emit → 인용 기계검증([확인 필요] 강등) + domain-graph emit
  → ktds /understand-docs      → docs/*.md (5종, DRAFT) + 근거·태그 (domain-graph 자동 병합)
      review --list/--doc      → DRAFT→UNDER_REVIEW
      confirm --doc            → 항목 확정 [추정]·[확정(AI)]→[확정(담당자)] + 감사
      approve --doc --by       → UNDER_REVIEW→APPROVED + 감사
      return --doc             → UNDER_REVIEW→RETURNED
      audit --list/--date      → 감사 로그 조회
  → ktds /understand-export    → 단일 HTML (CDN 없음)

  〔MVP+ · 분석 산출물〕
  → ktds /understand-impact    → docs/09_release/change-impact-analysis.md (읽기전용, 예측)
      seeds                    → 시드 매핑 카탈로그 (자연어→파일, host 역할)
      analyze --path <file>... → 역/정 도달성 → API·DB·흐름·연관모듈 영향 + 근거 검증
      status [--list]          → 마지막 분석 요약 / SR 보관 이력
  → ktds /understand-review    → docs/09_release/change-review-checklist.md (읽기전용, 실측)
      analyze [--base][--sr]   → git 변경분 → 도달성 영향 + 사전 예측 대조
```

### 호출 방식 — 두 가지 (아래 모든 예시는 ②로 표기)

| | 누가 | 형태 |
| --- | --- | --- |
| **①** | 플러그인 설치 사용자 | 슬래시 **`/understand-docs <projectRoot> <서브커맨드>`** — Claude(host)가 내부적으로 ②를 실행 |
| **②** | 직접 / 개발 | **`node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-docs.mjs <projectRoot> <서브커맨드>`** |

> 즉 아래 예시의 **`node …/understand-docs.mjs` 를 `/understand-docs` 로 바꾸면 그대로 슬래시(플러그인) 형태**가 된다. `<서브커맨드>`(`review --list`, `confirm --doc <f>`, `approve --doc <f> --by <handle>` …)는 두 방식이 동일하다. 스킬: `/understand`(U-A) · `/understand-init` · `/understand-map`(도메인 맵: scan→✋경계 확정→bundle→채움→emit — 03 기능명세의 공급원) · `/understand-docs` · `/understand-export` · 〔MVP+〕 `/understand-impact`(변경 영향도 예측 — §2-2) · `/understand-review`(변경분 실측 리뷰 — §2-3). (플러그인 **설치/업데이트/삭제**는 [INSTALL.md](./INSTALL.md) §2~§4의 `/plugin …` 명령.)

## 1. 사전: 지식 그래프 생성 (U-A)

```
/understand <projectRoot>
```
→ `<projectRoot>/.understand-anything/knowledge-graph.json` 생성. ktds는 이 파일만 읽는다(U-A 내부 API 미사용).

## 2. 초기화

```bash
node ktds-legacy-plugin/scripts/understand-init.mjs <projectRoot>
```
- `understanding.config.json` 생성 + `.spec/`(00_MASTER.md·templates) scaffold.
- 재실행은 기존 config 보존.

**understanding.config.json 주요 필드**

| 필드 | 기본 | 의미 |
| --- | --- | --- |
| `networkType` | `3` | 개방형(MVP). 1/2는 Phase 2 |
| `outputLanguage` | `"ko"` | 문서 언어 |
| `inferredRatioWarnThreshold` | `0.3` | `[추정]` 비율 경고선 |
| `inferredRatioBlockThreshold` | `0.6` | 초과 시 생성 중단(RUN_ABORTED) |
| `supportedSchemaVersions` | `["1.0.0"]` | 허용 U-A 그래프 버전 |
| `configFiles` | `[]` | 빌드 파일(pom.xml 등) — 언어/프레임워크 근거 |

## 2-1. 도메인 맵 (/understand-map — 03 기능명세의 공급원)

표준 `/understand`는 domain/flow/step 노드를 만들지 않아 03_feature-spec이 빈다. `/understand-map`이 이를 **결정론으로** 공급한다 (ADR-001). `/understand`와 실행 순서 무관 — KG는 교차검증·힌트로만 쓴다.

```bash
node ktds-legacy-plugin/scripts/understand-map.mjs <projectRoot> scan     # 스캔 (결정론, 재실행 byte-diff=0)
node ktds-legacy-plugin/scripts/understand-map.mjs <projectRoot> plan    # 후보 표 (key·루트·엔트리·모호/미해소 큐)
node ktds-legacy-plugin/scripts/understand-map.mjs <projectRoot> confirm # ✋ 경계 확정 (TTY 인터랙티브)
node ktds-legacy-plugin/scripts/understand-map.mjs <projectRoot> bundle  # LLM 입력 번들 (.spec/map/bundle/)
# (LLM 채움: 슬래시 사용 시 Claude가 SKILL.md 계약대로 fill/<key>.json 작성 — 모든 사실 주장에 파일:라인+스니펫 인용 의무)
node ktds-legacy-plugin/scripts/understand-map.mjs <projectRoot> emit    # 인용 기계검증 + domain-graph.json
node ktds-legacy-plugin/scripts/understand-map.mjs <projectRoot> status # 게이트 확정 상태
```

- **✋ 게이트는 생략 불가** (자동 도메인 경계의 전문가 일치율 한계 — ADR §1.3). TTY 세션 명령: `a`=승인 / `r <key> <새이름>`=개명 / `m <from> <into>`=병합 / `v <루트경로> <key>`=루트 이동 / `x <key>`=제외 / `q`=저장 없이 종료. 일괄 승인은 `confirm --auto-approve --by <핸들>`. 디스패처성 후보(web.xml의 `web` 등)는 보통 제외 대상.
- 확정은 `.spec/map/domain-plan.confirmed.json`으로 영속(재실행의 결정론 닻) + `MAP_PLAN_CONFIRMED` 감사. 코드가 변해 루트가 증감하면 scan이 **드리프트 경고**를 낸다 → 재확정.
- emit의 기계검증: 인용 경로 실존 → 라인 범위 → 텍스트 일치 → 사소 스니펫 무효. 실패 항목은 삭제 대신 **`[확인 필요]` 강등** — 03 문서에서 항목 확정 워크플로(§4-1)에 자연 합류한다. 근거율 리포트: `.spec/map/verify-report.json`. 실패 도메인만 fill 재작성 후 emit 재실행(멱등).
- 슬래시(비-TTY) confirm은 임의 전체 확정이 차단되고 Claude가 항목 단위로 묻는다 (`understand-docs` confirm과 동일 원칙).

## 2-2. 변경 영향도 분석 (/understand-impact — MVP+, 읽기전용)

"이 파일/기능을 바꾸면 어디까지 영향이 갈까?"를 결정론으로 답한다 (ADR-002). `/understand-map scan` 산출물(`.spec/map/`) 위에서 **재스캔 없이** 역/정 도달성을 계산한다. **upstream(역방향)=영향받는 호출자 → API·진입점·업무 흐름**, **downstream(정방향)=의존 협력자 → DB·영속성(매퍼)**.

```bash
node ktds-legacy-plugin/scripts/understand-impact.mjs <projectRoot> seeds                       # 시드 매핑 카탈로그(라우트·도메인·파일)
node ktds-legacy-plugin/scripts/understand-impact.mjs <projectRoot> analyze --path <파일> [--path <파일2> ...] [--sr <SR-ID>] [--by <핸들>]
node ktds-legacy-plugin/scripts/understand-impact.mjs <projectRoot> status                      # 마지막 분석 요약
node ktds-legacy-plugin/scripts/understand-impact.mjs <projectRoot> status --list               # SR 보관 이력(.spec/impact/)
```

- **전제:** `/understand-map scan` 이 `.spec/map/` 산출물을 만들어둬야 한다(없으면 안내하며 멈춤, exit 2). 흐름/도메인 영향까지 보려면 `confirm`까지 끝나 있어야 한다(아니면 `[확인 필요]` 강등).
- **자연어→시드 매핑은 host(Claude) 역할:** 엔진은 `--path` 파일만 받는다. 슬래시 사용 시 Claude가 `seeds` 카탈로그로 자연어를 후보 파일에 매핑하고 **✋사용자 확인 게이트**를 거친 뒤 `--path`로 실행한다(SKILL.md). `--path` 없이 호출하면 임의 분석을 하지 않고 카탈로그+안내만 낸다(fail-closed).
- **산출:** `.spec/map/impact.json`(결정론, 동일 시드+commit byte-diff=0) + `impact-verify-report.json`(근거율) + `docs/09_release/change-impact-analysis.md`(읽기전용 — 5종과 달리 **검토·승인 상태기계 밖**, registerDraft 미호출) + `IMPACT_ANALYZED` 감사. 보고서에는 **영향 규모 집계**(도메인×상류/하류·언어×상류/하류 파일 수 — 공수 산정 입력, 도메인 귀속=슬라이스 ownership: 단일 도메인=해당 도메인 · 복수=`(공용)` · 미도달/확정 밖=`(미분류)`)가 포함된다.
- **SR 보관 (`--sr <SR-ID>`):** 분석 사본(impact.json+verify+보고서)을 `.spec/impact/<SR-ID>/`에 보관 — 동시 다발 SR을 다루는 PL의 건별 이력. 같은 SR 재분석은 덮어씀(그 SR의 최신). `status --list`로 조회. SR ID는 영숫자 시작, 영숫자·점·하이픈·밑줄만(fail-closed). 보관본도 읽기전용 분석물이다(상태기계 밖).
- **대시보드 시각화 (자동 — 예측 채널):** analyze가 KG(`.understand-anything/knowledge-graph.json`)가 있으면 **`.understand-anything/impact-overlay.json`(예측 전용 채널)**을 발행한다. `/understand-dashboard`의 **'영향도' 토글(`i` 키)** — 적색="시드" 배지, 호박색="영향" 배지, 재분석 후 새로고침:
  - **구조 뷰** — 노드 배지 + 무관 노드 흐림. **계층(첫 화면) 카드·폴더 컨테이너**에 개수 칩 + 적/호박 테두리(무관 계층 흐림) — 드릴인 없이 위치 식별.
  - **도메인 뷰** — 도메인/흐름 카드에 개수 칩, step에 배지(체인에 등장하는 파일만 — 도달 폐포 전체는 구조 뷰·보고서가 정본).
  - **Diff 토글(`d` 키)은 별개 채널** — 실측 비교(§2-3 /understand-review, 라벨 "변경됨/영향받음"). 두 토글은 배타적이고, 둘 다 데이터가 있으면 최신 분석이 자동 활성.
  - 한계: 상류/하류 구분 색·API/DB 표는 대시보드에 없음(보고서 .md가 정본). KG 부재 시 생략, 시드 미조인 시 경고. 대시보드는 ADR-003에 따라 ktds 소유(분기).
- **API 영향 confidence:** `both`(ownership+reverse 일치)=`[확정(AI)]`, 단일 신호=교차검증 불일치(`[추정]`/`[확인 필요]`). 과도전파(hub)·`crossCheckDiff`·`needsReview`는 "영향 과대 추정 지점"으로 그대로 보고된다.
- **DB 테이블/컬럼은 host 보강:** 엔진은 영향 매퍼 XML까지만 결정론 산출(실 KG에 reads_from/writes_to 0건). `tableCandidateSlots`의 SQL 슬라이스에서 host가 테이블/컬럼을 인용 추출하고 KG table 노드(이름→DDL 라인)로 근거를 붙인다. 동적 SQL은 `[확인 필요]`.
- **한계:** step 입도가 라우트-선언-파일 단위라 흐름 영향은 `[추정]`. 비-Java 시드(JSP/TS/web.xml)는 edges가 java 기반이라 역방향이 빈약 → `[확인 필요]` 강등.
- 정확도 하네스: `scripts/impact-recall.mjs <root> <expected.json> --min-recall <p> --min-precision <p>`(사람 작성 정답지 대비 recall+precision).

## 2-3. 변경분 실측 리뷰 (/understand-review — MVP+, 읽기전용)

§2-2가 "바꾸면 어디까지?"(예측)라면, 이건 **"실제로 바뀐 것의 영향"**(실측)이다. `git diff`(base..워킹트리, **미커밋 포함**)가 보고한 변경 파일을 같은 결정론 엔진에 시드로 투입한다 — 코드 리뷰·머지 전·배포 전 게이트용. **git 저장소 필수**(아니면 exit 2).

```bash
node ktds-legacy-plugin/scripts/understand-review.mjs <projectRoot> analyze [--base <ref>] [--sr <SR-ID>] [--by <핸들>]
```

- **base 기본값** = 마지막 map 스캔 시점 commit(census.gitCommit) — "그때 이후 바뀐 것 전부". 특정 브랜치 대비는 `--base origin/main`. 실행 시 map을 자동 재스캔해 현재 코드 기준으로 계산한다(도메인 confirm 게이트 무관).
- **산출:** `.spec/map/review.json` + `review-verify-report.json`(예측 산출물 `impact.json`은 보존) + `docs/09_release/change-review-checklist.md`(읽기전용) + `REVIEW_ANALYZED` 감사. 시드=실제 변경 파일(`[확정(AI)]` — git 사실). 삭제 파일은 도달성 밖이라 "수동 확인" 절로 분리.
- **예측 대조 (`--sr`):** 사전 영향 분석 보관본과 대조 — **예측 밖 변경**(사전 영향 범위에 없던 파일이 바뀜 → 변경 사유 확인)과 **예측 시드 미변경**(계획 변경/작업 누락 후보)을 체크리스트에 경고. 리뷰 결과는 같은 SR 폴더에 보관되어 예측·실측이 나란히 남는다(`status --list`에 `[리뷰 있음]`).
- **대시보드:** `.understand-anything/diff-overlay.json`(실측 채널) 발행 — **Diff 토글(`d` 키)**, 적색="변경됨"(진짜 변경), 호박색="영향받음". U-A `/understand-diff`가 쓴 기존 파일은 `.bak` 보존 후 덮어씀.
- **주의:** untracked 신규 파일도 변경분에 포함된다(census와 동일 기준 — `git add` 불필요). 비-git(SVN 등) 프로젝트에서는 이 기능을 쓸 수 없다(예측 분석은 가능). **커밋된 변경을 리뷰할 땐 `--base`를 명시**하라 — 리뷰 실행이 map을 재스캔해 기본 base(census.gitCommit)가 현재 HEAD로 이동하므로, 커밋 후 두 번째 기본 실행은 "변경 없음"이 된다.

## 3. 문서 생성

```bash
node ktds-legacy-plugin/scripts/understand-docs.mjs <projectRoot>
```
→ `docs/`에 5종 DRAFT 생성: `01_tech-stack` · `02_architecture` · `03_feature-spec` · `04_api-spec` · `05_db-spec`. 감사에 `DOC_GENERATED` 기록.
- `domain-graph.json`이 있으면 **자동 병합**되어 03에 도메인/엔터티/업무 규칙이 근거와 함께 렌더된다. domain 노드가 없으면 "/understand-map 먼저" 경고.
- domain-graph가 KG·생성 commit보다 오래되면 **freshness 경고** → `emit` 재실행 권장.

> 스크립트는 **결정론 skeleton**(근거·태그·구조)만 생성한다. 자연스러운 산문 본문은 host CLI(Claude)가 SKILL.md 지시에 따라 각 섹션의 claim만 근거로 채운다.

**신뢰도 태그**

| 태그 | 의미 |
| --- | --- |
| `[확정(AI)]` | 코드에서 직접 확인(근거 file:line 필수) |
| `[확정(담당자)]` | 담당자 확정 |
| `[추정]` | 추론 — 검토 권장 |
| `[확인 필요]` | 동적 코드 등 자동 판단 불가 |

## 4. 검토 / 승인 / 감사

```bash
# DRAFT 목록 + [추정]/[확정(AI)]/[확인 필요] 수
node …/understand-docs.mjs <root> review --list

# 검토 시작 (DRAFT→UNDER_REVIEW) — TTY면 곧바로 인터랙티브 확정 세션 진입
node …/understand-docs.mjs <root> review --doc 04_api-spec.md

# 승인 (UNDER_REVIEW→APPROVED) — by 는 핸들/이니셜(실명·사번 금지)
#   ★ 승인 게이트: [확정(담당자)] 아닌 항목이 남으면 거부 → 먼저 모두 confirm. --force 로 우회(강제 승인 기록).
node …/understand-docs.mjs <root> approve --doc 04_api-spec.md --by ipark
node …/understand-docs.mjs <root> approve --doc 04_api-spec.md --by ipark --force   # 미확정 잔여 강제 승인(forced)

# 반려 (UNDER_REVIEW→RETURNED)
node …/understand-docs.mjs <root> return --doc 03_feature-spec.md

# 감사 조회
node …/understand-docs.mjs <root> audit --list
node …/understand-docs.mjs <root> audit --date 2026-06-09
```

### 4-1. 항목 확정 ([추정]·[확정(AI)]·[확인 필요] → [확정(담당자)])

승인(approve)은 **문서 단위**다. 그 전에, 문서 안의 개별 claim을 담당자가 **항목 단위**로 확정한다. 확정 대상은 **[확정(담당자)]가 아닌 모든 claim** — **[추정]**(근거 없음) · **[확정(AI)]**(AI 근거 있음 → 담당자가 검증·책임 인수) · **[확인 필요]**(순환 의존 후보 등 사람 판단 필요 → 담당자가 검토·확정).

```bash
# (권장) 인터랙티브 확정 세션 — DRAFT면 자동으로 검토 시작(UNDER_REVIEW)하므로 review --doc 불필요
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md
#   · 담당자 핸들은 세션 시작 시 1회만 입력 → 이후 재사용 (이번 실행 동안 메모리만, 디스크 미저장)
#   · 목록에서 "번호"를 입력해 해당 항목만 콕 집어 확정
#   · "a" = 남은 전체 확정,  "by <핸들>" = 담당자 변경,  "q"/Ctrl+D = 종료
#   · 확정마다 DOC_ITEM_CONFIRMED 감사(실제 사용 핸들 기록)

# (자동화/플러그인) 비대화 — --by 명시 필요 (핸들은 비거나 '-'로 시작 불가)
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md --list             # 확정 대상 목록
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md --item 3 --by ipark  # 단건
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md --all  --by ipark    # 전체(명시)
```

> 담당자 핸들을 **디스크에 저장하지 않으므로**(O3), 같은 머신에서 사람이 바뀌면 인터랙티브 세션에서 `by <핸들>`로 바꾸거나 비대화 `--by`로 명시한다. 감사 로그에는 항상 **그 항목을 실제로 확정한 핸들**이 박힌다.

> **플러그인(슬래시 `/understand-docs`)으로 confirm할 때**: 인터랙티브 세션은 **터미널 직접 실행(TTY)에서만** 동작한다. 슬래시는 host(Claude)가 비-TTY로 실행하므로 `confirm --doc <f>`(인자 없이)는 **목록과 안내만 출력하고 아무것도 확정하지 않는다**(임의 전체 확정 방지). host는 목록을 보여주고 **어느 항목·담당자**를 물은 뒤 선택분만 `--item`으로 확정하며, 사용자가 "전체"를 명시한 경우에만 `--all`을 쓴다.

상태기계: `DRAFT → UNDER_REVIEW → APPROVED`, 반려는 `UNDER_REVIEW → RETURNED → DRAFT`. 불법 전이(예: DRAFT를 바로 approve)는 거부된다. 항목 확정은 `UNDER_REVIEW`에서만 허용되나, **`confirm`은 DRAFT 문서를 자동으로 `UNDER_REVIEW`로 올린 뒤 진행**한다(`review --doc` 생략 가능). 단 RETURNED/APPROVED 문서는 자동 전이하지 않고 거부된다 — 반려본은 수정 후 재생성한다.

> **승인 게이트(정책):** `approve`는 문서의 모든 claim이 `[확정(담당자)]`일 때만 통과한다. `[추정]`·`[확정(AI)]`·`[확인 필요]`가 하나라도 남으면 거부하며, 남은 개수와 예시를 알려준다. 급히 승인해야 하면 `--force`로 우회하되, 그 승인은 `approvals.json`과 감사 로그(`DOC_APPROVED` detail)에 `forced`로 남아 추적된다.

**산출 상태 파일** (`<root>/.spec/`)
- `doc-status.json` — 문서별 상태
- `approvals.json` — 승인 기록(doc·by·at)
- `audit/YYYY-MM-DD.jsonl` — 감사 로그(append-only)

감사 이벤트: `LLM_REQUEST` · `DOC_GENERATED` · `DOC_ITEM_CONFIRMED` · `DOC_APPROVED` · `RUN_ABORTED` · `INIT_RERUN` · `STALE_LOCK_REMOVED` · `MAP_PLAN_CONFIRMED`(도메인 경계 확정) · `IMPACT_ANALYZED`(변경 영향 분석). (보안 이벤트는 Phase 2)

## 5. 내보내기

```bash
node ktds-legacy-plugin/scripts/understand-export.mjs <projectRoot> [out.html]
```
→ 기본 `<root>/docs/index.html`. 외부 CDN/리소스 없음(폐쇄망 배포 가능), 사이드바 TOC, 신뢰도 태그 색상.

## 6. 운영 원칙

- **비민감 샘플 전용** — 실제 고객 코드 금지(Phase 2 보안 게이트 선행).
- 승인자는 **핸들/이니셜만** 저장(실명/사번 미저장).
- 동시 실행은 `.spec/.analysis.lock`으로 단일 워크스테이션 내 직렬화.
- 생성은 staging→atomic publish로 부분 산출 없음(실패 시 기존 문서 불변).

장애 시 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) 참조.
