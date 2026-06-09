# Step 4 — export(HTML) + E2E 통합 + SKILL 배선 (MVP 코어 완성)

> 날짜: 2026-06-09 · 브랜치 `ktds/mvp-stage1` · 커밋 `cd0cf3d`
> 계획: `.omc/plans/mvp-legacy-ai-docs.md` 단계4(Export/안정화) + 전체 파이프라인

---

## 0. 이번에 뭘 했나 (한 줄)

흩어져 있던 8개 모듈을 **"명령 한 줄 → 문서 + HTML"** 하나의 흐름으로 묶고, 그게 실제로 도는지 E2E로 증명했다. MVP 코어 9/9 모듈 완성.

## 1. export — HTML 내보내기 (`src/export/`)

5종 문서 → **독립 실행 단일 HTML**: CSS 인라인(외부 CDN/리소스 0, 폐쇄망 배포 가능 A9), 카테고리별 사이드바 TOC, 신뢰도 태그 색상. XSS 안전(모든 사용자 내용 escape, 파일명은 allowlist slug + 인덱스 prefix로 앵커 충돌 방지). 결정론적.

## 2. orchestrator — 전체 파이프라인 (`src/orchestrator/`)

`runDocsPipeline()` = `/understand-docs` 의 결정론 코드 흐름(§3.2):
```
lock 획득(stale 정리) → graph 로드(version+fingerprint 가드) →
5종 생성(staging) → 근거 검증(CONFIRMED_AI 근거없음→RETURNED) →
[추정] 비율 게이트(config block 0.6 초과→RUN_ABORTED) →
atomic publish → DRAFT 등록 + 감사(DOC_GENERATED) → lock 해제
```
- **all-or-nothing:** 중간 실패 시 staging 통째 폐기(기존 문서 불변) + RUN_ABORTED 감사.
- lock은 모든 경로에서 해제(감사 먼저, 그다음 해제; 감사 실패가 원인 오류를 안 가림).
- 실제 LLM 산문은 `ProseProvider`(host CLI=Claude)가 주입.

## 3. SKILL 배선 (`scripts/` + `skills/`)

3개 진입 스크립트(`understand-init/docs/export.mjs`)와 SKILL.md 연결. `understand-docs` SKILL은 **Claude가 각 섹션 산문을 "그 섹션 claim만 근거로" 채우는 역할**을 명시(근거 밖 단정 금지).

## 4. 실제 동작 — E2E 확인

- **단위/E2E 테스트 113개 통과.** E2E 4종: 정상(5문서 발행+DRAFT+감사) / RUN_ABORTED(미발행+staging폐기+lock해제) / review→approve / live-lock 거부.
- **실제 실행:**
  - `sample-output.html`(15KB, 외부 링크 0) 생성 — 브라우저로 열어볼 수 있음.
  - Java 풍 그래프 파이프라인: 5문서 발행 + 감사 `LLM_REQUEST → DOC_GENERATED×5`, 실제 근거 `src/OrderController.java:30` 인용.
  - U-A 자기분석 그래프(tech-stack 100% 추정)는 **RUN_ABORTED**(게이트 정상 작동).
- 작성/검토 분리: 독립 코드리뷰 **APPROVE-WITH-NITS** → audit-mask 가드·abort phase 태그·앵커 충돌·single-quote escape 등 수정 + 회귀 테스트.

## 5. 누적 상태 — `@ktds/legacy-core` **9/9 코어 모듈 ✅**
```
config kg-reader evidence  doc-state audit lock approval  doc-generator export  + orchestrator
```
커밋: a47a48e(부트스트랩) · 0be4be0(S1) · 9d01f5b(S2) · e4750aa(S3) · cd0cf3d(S4)

## 6. 아직 안 된 것 / 알려진 한계

- **실제 LLM 산문 생성**은 런타임(Claude) 몫 — 코어는 인터페이스(ProseProvider)만. 스크립트 직접 실행은 skeleton(근거·구조)만.
- **review/approve/audit CLI 서브커맨드 스크립트 미작성** — 엔진 함수(approval·audit)는 있고 테스트됨, CLI 표면만 남음.
- **플러그인 실설치 검증 안 함** — 마켓플레이스 `/plugin install` 로 Claude Code에 올려 실제 `/understand-docs` 호출하는 통합은 미검증(스크립트는 node 직접 실행으로만 확인).
- **tech-stack [추정] 비율 이슈:** 언어/프레임워크가 project-meta 유래라 파일 근거 없어 INFERRED → tech-stack이 쉽게 block 0.6 초과. 실제 Java 대상(module 노드 다수)에선 완화되나, **project-meta claim을 비율에서 제외하거나 빌드파일 근거 부착**이 필요(후속 정련).
- **실제 Java/Spring/MyBatis/Oracle 샘플 fixture로 U-A `/understand` 실행 → 전체 검증**은 미수행(현재 U-A 동봉 샘플 기반).
- 성능 측정(§5 50K/200K), 매뉴얼(단계5), adapter smoke — 미수행.

## 7. 검증된 인수 기준

A2/A11(결정성)·A3/A4/A5(근거·태그)·A6(추정 게이트)·A7/A8(상태전이)·A9(HTML 자립)·§2.2(staging atomic)·§3.5(lock) — MVP 코어 파이프라인 충족. (보안 A14~ 일부는 Phase 2)

## 다음(예정)

review/approve/audit CLI 표면 + 실제 Java fixture로 U-A `/understand`→전체 E2E + 플러그인 실설치 검증 + 성능/매뉴얼 → step5.md.
