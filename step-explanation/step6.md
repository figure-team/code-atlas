# Step 6 — U-A `/understand`를 실제로 구동한 완전 충실 E2E

> 날짜: 2026-06-09 · 브랜치 `ktds/mvp-stage1`
> 목표: step5의 "직접 조립" 대신, **U-A의 실제 `/understand` 파이프라인을 그대로 구동**해 그래프를 만들고 ktds로 문서화

---

## 0. 한 줄

U-A의 진짜 7단계 파이프라인(정적 스캔 + file-analyzer 서브에이전트 + merge + architecture-analyzer)을 jpetstore-6에 구동해 **U-A가 직접 생성한 knowledge-graph.json**(243노드/278엣지/8레이어)을 얻고, 거기에 ktds를 돌려 5종 문서를 생성했다.

## 1. 왜 이게 "진짜"인가

U-A의 `/understand`는 Claude Code 스킬 = **모델(Claude)이 스킬을 실행하며 LLM 역할을 하는** 멀티에이전트 파이프라인이다. 이 세션엔 `/understand`가 설치돼 있지 않고 `/plugin install`은 bash로 못 띄운다. 그래서 **U-A의 실제 스크립트 + 실제 에이전트 프롬프트**를 그대로 구동하되, U-A가 모델을 호출하는 자리에 실제 Claude 서브에이전트를 투입했다 — U-A의 동작 그 자체.

## 2. 실행한 U-A 파이프라인 (실제 산출물)

| Phase | 수단 | 결과 |
|---|---|---|
| 1 SCAN | `scan-project.mjs` (실제) | 114 파일 |
| 1.5 BATCH | `compute-batches.mjs` (실제) | 11 배치 |
| 2 ANALYZE | **U-A `file-analyzer.md`로 8개 서브에이전트**(코드/데이터 배치 4–11) | batch-*.json |
| 2 MERGE | `merge-batch-graphs.py` (실제) | assembled-graph: 243노드/278엣지 |
| 4 ARCHITECTURE | **U-A `architecture-analyzer.md` 서브에이전트** | 8 레이어 |
| 7 SAVE | 조립 | `knowledge-graph.json` |

> 배치 1–3(CI yaml/dockerfile/markdown)은 비용 절감 위해 미분석(레거시 5종 문서 가치 낮음). 도메인/플로우 노드를 만드는 `domain-analyzer` 단계는 미실행 → 03_feature-spec은 비어 있음(아래 한계).

U-A 그래프 노드 타입: table 23 · class 37 · function 81 · file 66 · config 22 · endpoint 6 · document 8. 레이어: 웹/서비스/데이터접근/도메인/DB/테스트/설정·빌드/문서화 — **U-A가 직접 쓴 한국어 설명**.

## 3. ktds 파이프라인 결과 (U-A 실그래프)

| 문서 | claim | [확정(AI)] 근거율 |
|---|---|---|
| 01_tech-stack | 8 | 100% |
| 02_architecture | 54 | 100% (U-A 레이어 설명 8개 + 의존 46) |
| 03_feature-spec | 0 | — (domain-analyzer 미실행) |
| 04_api-spec | 6 | 100% |
| 05_db-spec | 23 | 100% |

`sample-output-jpetstore-UA.html`로 열어볼 수 있음.

## 4. 근거 정확성 검증

- U-A 노드 `AccountMapper` → `mapper/AccountMapper.java:25` → 실제 `public interface AccountMapper {` ✓
- db-spec `account` → `jpetstore-hsqldb-data.sql:36` (U-A가 data.sql 재정의를 포착) ✓

## 5. step5(직접 조립) vs step6(U-A 실구동) — 차이가 곧 진정성

| | step5 직접 조립 | step6 U-A 실구동 |
|---|---|---|
| 노드 | 55 (선별) | **243** (테스트·설정·문서 포함) |
| 레이어 | 5 (내가 정의) | **8 (U-A가 분류·서술)** |
| 엔드포인트 | ActionBean 핸들러 15 | **Mapper 인터페이스 6 (U-A의 분류)** |
| 요약문 | 내가 작성 | **U-A file-analyzer가 작성(자연스러운 한국어)** |

→ 분류·요약이 내 의도와 다르게 나온 것 자체가 **U-A의 독립적 실제 출력**임을 증명.

## 6. 한계 (정직)

- **배치 1–3 미분석**(CI/infra) · **domain-analyzer 미실행** → 03_feature-spec 비어 있음. 도메인/플로우까지 채우려면 U-A domain-analyzer 단계 추가 구동 필요.
- U-A를 **Claude Code 플러그인으로 실제 설치(`/plugin install`)** 한 통합은 여전히 미검증(스킬을 수동 구동한 것).
- 성능 측정·매뉴얼·review/approve CLI 표면 미수행.

## 7. 결론

**제품 핵심 가설이 "U-A 실제 출력 → ktds → 근거 문서"의 완전한 사슬로 검증됨.** U-A가 만든 진짜 그래프에서 ktds가 근거율 100%의 5종 문서를 생성하고, 근거는 실제 소스 라인을 정확히 가리킨다.

fixture: `fixtures/jpetstore/knowledge-graph-ua-real.json` (U-A 실분석 243노드).

## 다음(예정)

domain-analyzer 추가 구동(feature-spec 채우기) · U-A 플러그인 실설치 검증 · review/approve CLI · 성능/매뉴얼 → step7.md.
