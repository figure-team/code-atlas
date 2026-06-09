# Step 1 — 부트스트랩 + Core 골격 (config / kg-reader / evidence)

> 날짜: 2026-06-08 · 브랜치 `ktds/mvp-stage1` · 커밋 `a47a48e`(부트스트랩), `0be4be0`(모듈)
> 계획: `.omc/plans/mvp-legacy-ai-docs.md` 단계1

---

## 0. 큰 그림

기획서(`plan/`)만 있고 코드는 0이던 greenfield에서 출발 → ① 계획 수립(`/plan` + 합의 검토) → ② 통합 모델을 npm → **fork-and-extend 플러그인**으로 전환(기획서도 동기화) → ③ 실행(`/omc-teams`)으로 단계1 토대 구현.

## 1. 이 디렉터리의 정체 = U-A fork

`apm/`은 이제 git 저장소이며 오픈소스 **Understand-Anything(U-A)의 fork**다.

```
0be4be0  (우리) 단계1 모듈 구현
a47a48e  (우리) 부트스트랩 스캐폴드
5c1e35f  U-A 원본 히스토리 (이하 전부 U-A)
```

- 왜 fork? U-A는 npm 패키지가 아니라 **Claude 플러그인**이라, 같은 플러그인으로 배포하려면 fork가 자연스럽다(사용자 결정).
- **원본 보존 검증:** U-A 소스(`understand-anything-plugin/`) 수정 파일 = **0**. 우리가 손댄 추적 파일은 `pnpm-workspace.yaml`·`marketplace.json`(등록 additive)·`pnpm-lock.yaml`(자동)·`plan/*`(기획서 수정)뿐. → upstream merge 용이.

## 2. 추가물 — `ktds-legacy-plugin/` (전부 격리 폴더)

```
ktds-legacy-plugin/
├ .claude-plugin/plugin.json        "ktds-legacy" 플러그인 정의
├ skills/{understand-init,-docs,-export}/SKILL.md   사용자 명령 3종 (현재 stub)
└ packages/legacy-core/             엔진 (TypeScript, @ktds/legacy-core)
    src/types.ts                    공통 모델(근거 태그·uid·상태)
    src/config/  · kg-reader/ · evidence/   ← 구현 완료
    src/doc-generator/              ← stub (단계2)
```

## 3. 구현된 3개 모듈

목표 파이프라인 `U-A 그래프 → 근거 붙은 문서`의 앞단 3조각.

- **config** (78줄): `understanding.config.json` 로드+기본값(유형3 / ko / 추정 0.3·0.6 / 스키마 1.0.0), `.spec/` scaffold. 파일 없어도 기본값, 재실행 안전.
- **kg-reader** (295줄): U-A `knowledge-graph.json` → ktds 표준형. U-A 일련번호 id 버리고 안정적 uid(`LoginController#login`) 생성. 스키마 드리프트 가드(모르는 타입/필드 → 경고/중단).
- **evidence** (59줄): 모든 claim에 근거 강제. **`[확정(AI)]`인데 근거 없으면 저장 거부(RETURNED)**. `[추정]` 비율 warn 0.3 / block 0.6.

→ 제품 1번 축("근거 없으면 문서 안 쓴다")의 토대.

## 4. 제작 방식 + 품질

- 부트스트랩(저장소 세팅·U-A clone·빌드 검증·`UA_BASELINE.md`)은 메인 세션이 순차로.
- 모듈 3개는 `/omc-teams` 워커 3개(claude 2 + codex 1) **병렬**(폴더 분리로 충돌 0).
- 워커 산출물을 **독립 코드리뷰**(자가승인 금지) → kg-reader 실버그 3건 발견·수정:
  - HIGH-1 uid 충돌 비유일 → 결정론적 tiebreak로 유일 보장
  - HIGH-2 깨진 노드 silent pass → 필수필드 없으면 즉시 실패
  - HIGH-3 version 가드 config 무시 → config 값 주입
- **검증:** `tsc` 통과 + **테스트 54개 전부 통과**(config 8 / kg-reader 28 / evidence 18).
  - 재현: `pnpm --filter @ktds/legacy-core test`

## 5. 아직 안 된 것 (한계)

- 9개 모듈 중 3개만. `doc-state·approval·audit·export·doc-generator`는 stub.
- SKILL.md 3개 명령은 껍데기(실제 동작 X).
- end-to-end 미검증(실제 Java 샘플에 U-A `/understand` → 문서). 현재 테스트는 U-A 동봉 97노드 샘플 그래프 fixture 기반.

## 6. 검증된 인수 기준

A1(원본 무수정) · A14(드리프트 가드) · A15(uid 안정/충돌) · A18(엣지 타입명 = 실소스) — 단계1 범위 충족.
