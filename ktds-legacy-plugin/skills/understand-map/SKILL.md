---
name: understand-map
description: 결정론 도메인 맵 — 전수 census/라우트/콜체인/도달성 → 사람 게이트 → LLM 채움(인용 의무) → 기계 검증 → domain-graph.json
argument-hint: ["[projectRoot]", "[scan | plan | confirm | bundle | emit | status]"]
---

# /understand-map

> ⚠️ 비민감 샘플 전용 (보안 게이트는 Phase 2).
> 🌐 **언어:** 사용자에게 보여주는 모든 설명·질문·요약은 **한국어**로 한다.

레거시 코드의 **도메인/기능 분석을 결정론으로 생산**한다 (ADR-001). U-A `/understand-domain`과 달리 구조(skeleton)는 LLM 이전에 100% 확정되고, LLM은 빈칸(name/summary/domainMeta)만 채우며, 모든 사실 주장은 `파일:라인` 인용이 의무이고 기계 검증(실파일 대조)을 통과해야 한다. 산출물 `domain-graph.json`은 U-A 대시보드 도메인 뷰와 `/understand-docs`의 03_feature-spec이 그대로 소비한다.

파이프라인: **S1~S6 스캔/skeleton(결정론) → S7 ✋사람 게이트 → S8 LLM 채움(너의 역할) → S9 기계 검증 → S10 emit**. `/understand`와 실행 순서 무관(KG는 교차검증·힌트로만 사용).

## 1) 스캔 (결정론 — census/라우트/콜체인/도달성/도메인 후보)
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-map.mjs <projectRoot> scan
```
`.spec/map/{census,routes,edges,slices,candidates}.json` 산출. 동일 commit 재실행 byte-diff=0.

## 2) ✋ 도메인 경계 확정 게이트 (S7 — 생략 불가)
자동 도메인 경계는 전문가 일치율 상한이 낮아(MoJoFM ~56%) 사람 확인이 필요하다.

- `plan` → 후보 표(key·루트·엔트리·파일수 + 모호/미해소 큐) 출력
- **터미널(TTY)**: `confirm` → 인터랙티브 세션 (`a`=승인 / `r <key> <새이름>`=개명 / `m <from> <into>`=병합 / `v <루트> <key>`=이동 / `x <key>`=제외 / `q`=저장 없이 종료)
- 일괄 승인: `confirm --auto-approve --by <핸들>`

> ⚠️ **플러그인(슬래시)으로 실행 = 비-TTY → 인터랙티브 세션 불가.** 절대 임의로 `--auto-approve`하지 말 것. 절차:
> 1. `plan` 출력(후보 표)을 사용자에게 보여준다.
> 2. 병합/개명/제외할 항목이 있는지, 승인자 핸들(이니셜)을 **한국어로** 묻는다.
> 3. 수정 요청은 터미널 TTY 세션을 안내하고, "후보 그대로 승인"을 명시적으로 받은 경우에만 `confirm --auto-approve --by <핸들>`.
>
> 디스패처성 후보(web.xml 등 `web` 키)는 보통 **제외 대상**임을 안내하라.

확정되면 `domain-plan.confirmed.json` 영속(재실행의 결정론 닻) + `MAP_PLAN_CONFIRMED` 감사. 이후 `scan`은 자동으로 skeleton까지 산출하고, 코드가 변해 루트가 증감하면 드리프트 경고를 낸다(재확정 권장).

## 3) 번들 (S8 입력 준비)
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-map.mjs <projectRoot> bundle
```
도메인별 `.spec/map/bundle/<key>.json` — flow/step 골격 + **step 대상 파일의 실제 소스 슬라이스**(인용용 텍스트) + KG 힌트(있으면).

## 4) LLM 채움 (S8 — 이 단계는 host CLI = 너의 역할)
도메인마다 `bundle/<key>.json`을 읽고 `.spec/map/fill/<key>.json`을 작성한다. **계약:**
- 채울 수 있는 것: 도메인 `name`(표시명)·`summary`, `entities`/`businessRules`/`crossDomainInteractions`, flow/step의 `name`·`summary` **만**. 구조(ID/엣지/순서/filePath/lineRange)는 read-only — 바꾸면 항목 단위 기각된다.
- **모든 사실 주장(summary 포함)에 인용 의무**: `citations: [{ filePath, line, snippet }]` ≥1. `snippet`은 그 라인의 실제 텍스트(번들 소스 슬라이스에서 복사). 지어낸 인용은 기계 검증(S9)이 100% 잡아 `[확인 필요]`로 강등된다.
- 텍스트는 한국어. 번들 슬라이스에 없는 사실을 단정하지 말 것.
- 스키마(요약): `{ schemaVersion: 1, domainId, name, summary: {text, citations}, entities: [{text, citations}], businessRules: [...], crossDomainInteractions: [...], flows: [{flowId, name, summary}], steps: [{stepId, name, summary}] }`

## 5) 검증 + emit (S9~S10)
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-map.mjs <projectRoot> emit
```
인용을 실파일과 대조(경로 실존 → 라인 범위 → 텍스트 일치) → 실패 항목은 삭제 대신 `[확인 필요]` 강등 → `.understand-anything/domain-graph.json` + `.spec/map/verify-report.json` 산출. 출력의 근거율과 미채움/기각 목록을 사용자에게 보고하고, **실패 도메인만** fill을 재작성해 다시 emit하면 된다(멱등).

## 6) 후속
- `/understand-docs` 실행 시 domain-graph가 자동 병합되어 03_feature-spec에 도메인/규칙/엔터티가 근거와 함께 렌더된다. domain-graph가 KG보다 오래되면 freshness 경고가 뜬다.
- U-A 대시보드(`/understand-dashboard`)는 domain-graph.json을 감지해 도메인 뷰를 보여준다.
- `status` → 게이트 확정 상태 확인.
