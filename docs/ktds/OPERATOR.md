# 운영자 매뉴얼 — ktds Legacy 문서 자동화

> ⚠️ **MVP는 비민감 샘플 전용.** 보안 게이트가 없으므로 실제 고객 코드 분석 금지(Phase 2 선행 필요).

## 0. 전체 흐름 (한눈에)

```
U-A /understand                → .understand-anything/knowledge-graph.json
  → ktds /understand-init      → understanding.config.json + .spec/
  → ktds /understand-docs      → docs/*.md (5종, DRAFT) + 근거·태그
      review --list/--doc      → DRAFT→UNDER_REVIEW
      confirm --doc            → 항목 확정 [추정]·[확정(AI)]→[확정(담당자)] + 감사
      approve --doc --by       → UNDER_REVIEW→APPROVED + 감사
      return --doc             → UNDER_REVIEW→RETURNED
      audit --list/--date      → 감사 로그 조회
  → ktds /understand-export    → 단일 HTML (CDN 없음)
```

### 호출 방식 — 두 가지 (아래 모든 예시는 ②로 표기)

| | 누가 | 형태 |
| --- | --- | --- |
| **①** | 플러그인 설치 사용자 | 슬래시 **`/understand-docs <projectRoot> <서브커맨드>`** — Claude(host)가 내부적으로 ②를 실행 |
| **②** | 직접 / 개발 | **`node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-docs.mjs <projectRoot> <서브커맨드>`** |

> 즉 아래 예시의 **`node …/understand-docs.mjs` 를 `/understand-docs` 로 바꾸면 그대로 슬래시(플러그인) 형태**가 된다. `<서브커맨드>`(`review --list`, `confirm --doc <f>`, `approve --doc <f> --by <handle>` …)는 두 방식이 동일하다. 스킬 4종: `/understand`(U-A) · `/understand-init` · `/understand-docs` · `/understand-export`. (플러그인 **설치/업데이트/삭제**는 [INSTALL.md](./INSTALL.md) §2~§4의 `/plugin …` 명령.)

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

## 3. 문서 생성

```bash
node ktds-legacy-plugin/scripts/understand-docs.mjs <projectRoot>
```
→ `docs/`에 5종 DRAFT 생성: `01_tech-stack` · `02_architecture` · `03_feature-spec` · `04_api-spec` · `05_db-spec`. 감사에 `DOC_GENERATED` 기록.

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
node …/understand-docs.mjs <root> approve --doc 04_api-spec.md --by ipark

# 반려 (UNDER_REVIEW→RETURNED)
node …/understand-docs.mjs <root> return --doc 03_feature-spec.md

# 감사 조회
node …/understand-docs.mjs <root> audit --list
node …/understand-docs.mjs <root> audit --date 2026-06-09
```

### 4-1. 항목 확정 ([추정]·[확정(AI)] → [확정(담당자)])

승인(approve)은 **문서 단위**다. 그 전에, 문서 안의 개별 claim을 담당자가 **항목 단위**로 확정한다. 확정 대상은 **[확정(담당자)]가 아닌 모든 claim** — **[추정]**(근거 없음) · **[확정(AI)]**(AI 근거 있음 → 담당자가 검증·책임 인수) · **[확인 필요]**(순환 의존 후보 등 사람 판단 필요 → 담당자가 검토·확정).

```bash
# (권장) 인터랙티브 확정 세션 — UNDER_REVIEW 문서에서
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md
#   · 담당자 핸들은 세션 시작 시 1회만 입력 → 이후 재사용 (이번 실행 동안 메모리만, 디스크 미저장)
#   · 목록에서 "번호"를 입력해 해당 항목만 콕 집어 확정
#   · "a" = 남은 전체 확정,  "by <핸들>" = 담당자 변경,  "q"/Ctrl+D = 종료
#   · 확정마다 DOC_ITEM_CONFIRMED 감사(실제 사용 핸들 기록)

# (자동화) 비대화 단건 — 매 호출마다 --by 필요
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md --list
node …/understand-docs.mjs <root> confirm --doc 04_api-spec.md --item 3 --by ipark
```

> 담당자 핸들을 **디스크에 저장하지 않으므로**(O3), 같은 머신에서 사람이 바뀌면 인터랙티브 세션에서 `by <핸들>`로 바꾸거나 비대화 `--by`로 명시한다. 감사 로그에는 항상 **그 항목을 실제로 확정한 핸들**이 박힌다.

상태기계: `DRAFT → UNDER_REVIEW → APPROVED`, 반려는 `UNDER_REVIEW → RETURNED → DRAFT`. 불법 전이(예: DRAFT를 바로 approve)는 거부된다. 항목 확정은 `UNDER_REVIEW`에서만 허용된다.

**산출 상태 파일** (`<root>/.spec/`)
- `doc-status.json` — 문서별 상태
- `approvals.json` — 승인 기록(doc·by·at)
- `audit/YYYY-MM-DD.jsonl` — 감사 로그(append-only)

감사 이벤트: `LLM_REQUEST` · `DOC_GENERATED` · `DOC_ITEM_CONFIRMED` · `DOC_APPROVED` · `RUN_ABORTED` · `INIT_RERUN` · `STALE_LOCK_REMOVED`. (보안 이벤트는 Phase 2)

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
