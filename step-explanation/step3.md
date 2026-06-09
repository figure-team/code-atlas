# Step 3 — doc-generator (근거 기반 5종 문서 생성)

> 날짜: 2026-06-09 · 브랜치 `ktds/mvp-stage1` · 커밋 `e4750aa`
> 계획: `.omc/plans/mvp-legacy-ai-docs.md` 단계2(문서 생성) §2.3/§2.2

---

## 0. 이번에 뭘 했나 (한 줄)

U-A 지식 그래프에서 **근거가 붙은 5종 문서(.md)를 실제로 생성**하는 모듈을 만들었다. 제품 1번 축(근거 기반 문서화)의 출력단.

## 1. 선결 작업 — kg-reader 확장

기존 `CanonicalGraph`는 노드/엣지만 담고 **project(언어·프레임워크)·layers**를 버렸다 → 01/02 문서에 필요해서 kg-reader가 이 둘도 표준형에 싣도록 확장(raw nodeIds→uid 매핑·중복 제거).

## 2. doc-generator — 5종 문서 (`src/doc-generator/`)

§2.3 매핑대로 그래프 노드/엣지 → 문서:
| 문서 | 소스 |
|---|---|
| `01_tech-stack.md` | project.언어/프레임워크 + module 노드 |
| `02_architecture.md` | layers + depends_on/imports 엣지 + **순환 의존 탐지** |
| `03_feature-spec.md` | domain/flow 노드 + contains_flow/flow_step 엣지 |
| `04_api-spec.md` | endpoint 노드 + routes/middleware 엣지 |
| `05_db-spec.md` | table/schema 노드 + reads_from/writes_to 엣지 |

핵심 설계:
- **결정론 skeleton vs LLM 산문 분리(§2.2/N-C2):** `build*()`와 `renderSkeleton()`은 결정론적 뼈대(uid·근거·태그·구조)만 생성 → golden-snapshot 대상. 실제 문장(prose)은 `ProseProvider`로 host CLI(Claude)가 런타임 주입(테스트는 `nullProseProvider`로 결정론 보장).
- **근거 태그:** 노드에 파일 근거 있으면 `[확정(AI)]`, 없으면 `[추정]`. 순환 의존은 `[확인 필요]`. (근거 없는 `[확정(AI)]` 구조적으로 불가 → A5)
- **순환 의존 탐지:** 3색 DFS, 다이아몬드(DAG)는 오탐 안 함.

## 3. 실제 동작 확인

빌드된 엔진을 실제 U-A 97노드 그래프에 돌린 결과:
```
01_tech-stack: claim 14개 ([추정] — 언어/프레임워크는 파일근거 없음, 정직)
02_architecture: claim 53개, [확정(AI)] 46개(근거율 100%), 순환 의존 탐지 동작
03/04/05: 0개 (U-A 자기분석 그래프엔 domain/endpoint/table 노드 없음 → 실제 Java/Spring 대상이면 채워짐)
```
→ 파이프라인 `그래프 → 근거 문서` 동작 확인.

## 4. 제작 + 품질 (작성/검토 분리)

- 구현은 메인 세션 직접.
- **독립 코드리뷰 → 판정 CHANGES-REQUIRED** — 실제 결함 수정:
  - **HIGH(결정성):** 엣지 정렬이 문자열 concat 비교(`"a"+"bc" === "ab"+"c"`, 0 반환 안 함) → **입력 순서에 따라 결과 달라져 A2/A11(재현성) 깨짐**. 현재 fixture엔 잠복(테스트 통과)이라 더 위험. → (src,tgt,type) 완전순서 비교자 + 순열 불변 회귀테스트로 수정.
  - **§2.3 누락:** feature-spec/api-spec이 contains_flow/flow_step·routes/middleware 엣지를 안 씀 → 소비하도록 보강.
  - 근거 가드 인라인(non-null 단언 제거), renderSkeleton 스냅샷 가드레일, layer uid 중복 제거, 다이아몬드 오탐 테스트.
- **검증:** `tsc` 통과 + **테스트 101개 전부 통과** (단계1·2 79 + doc-generator 17 + project/layers 1 + 회귀 4).

## 5. 누적 상태 — `@ktds/legacy-core` **8/9 모듈**
```
✅ config kg-reader evidence            (Step 1)
✅ doc-state audit lock approval        (Step 2)
✅ doc-generator                        (Step 3)
⬜ export (HTML)                         ← 남음
```

## 6. 아직 안 된 것

- **export(HTML)** 미구현 → 문서를 단일 HTML로 묶는 단계.
- **SKILL.md 3개 명령 배선** 안 됨 → `/understand-docs` 실제 실행 X.
- **E2E 통합**: config→kg-reader→evidence→doc-generator→검토/승인→export 전체 한 흐름 미검증.
- doc-generator의 **실제 LLM prose**는 런타임(Claude) 몫 — 코어는 인터페이스만.

## 7. 검증된 인수 기준

A2/A11(skeleton 결정성·재실행 diff=0) · A3/A4(근거율·태그) · A5(근거 없는 확정 불가) · §2.3(5종 매핑) — 단계2 문서생성 범위 충족.

## 다음(예정)

export(HTML) + SKILL.md 3종 배선 + **E2E 통합 테스트**(전체 파이프라인) → step4.md.
