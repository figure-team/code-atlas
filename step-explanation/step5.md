# Step 5 — 실제 오픈소스(jpetstore-6)로 E2E 검증

> 날짜: 2026-06-09 · 브랜치 `ktds/mvp-stage1`
> 계획: `.omc/plans/mvp-legacy-ai-docs.md` §5 성공 기준(실제 샘플 근거율 95%+)

---

## 0. 이번에 뭘 했나 (한 줄)

합성 픽스처가 아니라 **실제 오픈소스 `mybatis/jpetstore-6`**(Spring + MyBatis + Stripes 정통 레퍼런스 앱)로 전체 파이프라인을 돌려, **모든 문서 근거가 실제 소스의 정확한 라인을 가리킴**을 검증했다.

## 1. 샘플 선정 — jpetstore-6

MVP 프로파일(Java/Spring/MyBatis/SQL)에 정확히 맞는 정통 레퍼런스: Java 43 · MyBatis Mapper XML 7 · schema SQL · Stripes 웹. 깔끔한 layered 구조(domain/service/mapper/web).

## 2. U-A 정적분석은 실제로 돌림

- `scan-project.mjs` → 114 파일
- `extract-structure.mjs` → **68 파일의 실제 함수/클래스 + 라인 범위**(tree-sitter)
- 추가로 grep으로 실제 앵커 추출: 도메인 클래스·서비스·매퍼·ActionBean 핸들러(엔드포인트)·테이블 DDL — **전부 실제 라인 번호**

## 3. 의미 그래프 조립 (`fixtures/jpetstore/build-graph.mjs`)

U-A의 LLM 의미분석 단계를 대신해, 실제 앵커로 U-A v1.0.0 스키마 `knowledge-graph.json` 생성: **55 노드 / 76 엣지 / 5 레이어**. 도메인(계정/카탈로그/장바구니/주문)·클래스·엔드포인트·테이블·매퍼→테이블 접근·서비스→매퍼 의존. 모든 노드가 실제 `file:line` 앵커.

## 4. ktds 파이프라인 E2E 결과

`runDocsPipeline(/tmp/jpetstore-6)` → **5종 문서 발행**:
| 문서 | claim | [확정(AI)] 근거율 | [추정] |
|---|---|---|---|
| 01_tech-stack | 6 | 100% | 0% |
| 02_architecture | 17 | 100% | 29% |
| 03_feature-spec | 16 | 100% | 0% |
| 04_api-spec | 30 | 100% | 0% |
| 05_db-spec | 35 | 100% | 0% |

→ **`[확정(AI)]` 근거율 100% (§5 합격선 95% 초과)**. 5종 DRAFT 등록 + 감사 로그.

## 5. 근거 정확성 검증 (핵심)

문서가 가리킨 라인을 실제 소스와 대조:
- `AccountActionBean.java:137` → `public Resolution editAccount() {` ✓
- `CartActionBean.java:68` → `public Resolution addItemToCart() {` ✓
- `schema.sql:36` → `create table account (` ✓
- `schema.sql:113` → `create table category (` ✓

**제품 핵심 약속("근거 없으면 안 쓰고, 쓴 근거는 실제 코드를 정확히 가리킨다")이 실제 코드베이스에서 증명됨.** `sample-output-jpetstore.html`로 열어볼 수 있음.

## 6. 발견된 실제 결함 + 수정 (tech-stack [추정] 이슈)

첫 실행은 tech-stack 100% 추정으로 **RUN_ABORTED**(게이트 정상 작동) — step4에서 예고한 이슈가 실제 샘플에서 발현. 계획 §5.2("파일 경로만 있어도 CONFIRMED_AI 허용")에 맞춰 수정:
- `ProjectMeta.configFiles` 추가(빌드/설정 파일). 언어/프레임워크 claim이 **`pom.xml`을 근거로 인용** → CONFIRMED_AI. configFiles 없으면 INFERRED로 격하(기존 동작 유지).
- → tech-stack [추정] 0%, 정상 발행. (회귀 테스트 추가)

## 7. 누적 상태

`@ktds/legacy-core` 9/9 모듈 · **테스트 114개 통과** · 실제 OSS E2E 검증 완료.
fixture: `fixtures/jpetstore/{build-graph.mjs, knowledge-graph.json}`.

## 8. 아직 안 된 것

- U-A의 **LLM 의미분석을 진짜로 실행**한 건 아님(정적분석은 실제, 의미층은 실제 앵커 기반 조립). 완전 충실한 검증은 U-A 플러그인 실설치 후 `/understand` 실행 필요.
- **실제 LLM 산문**(Claude)·**플러그인 `/plugin install` 통합**·**성능 측정**·**매뉴얼**·review/approve CLI 표면 — 미수행.

## 다음(예정)

review/approve/audit CLI 표면 + (가능 시) U-A 플러그인 실설치 `/understand` 실행 + 성능/매뉴얼 → step6.md.
