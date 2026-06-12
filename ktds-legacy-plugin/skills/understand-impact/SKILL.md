---
name: understand-impact
description: 변경 영향도 분석 — 시드 파일에서 역/정 도달성으로 API/DB/업무흐름/연관모듈 영향을 결정론 산출 + 인용 검증. 자연어→시드 매핑은 host 역할(사용자 확인 게이트).
argument-hint: ["[projectRoot]", "[seeds | analyze | status]"]
---

# /understand-impact

> ⚠️ 비민감 샘플 전용 (보안 게이트는 Phase 2).
> 🌐 **언어:** 사용자에게 보여주는 모든 설명·질문·요약은 **한국어**로 한다.

"이 파일/기능을 바꾸면 어디까지 영향이 갈까?"를 **결정론 정적분석**으로 답한다 (ADR-002). /understand-map이 만든 `.spec/map/` 산출물(census·routes·edges·slices·skeleton) 위에서 **재스캔 없이** 역/정 도달성을 계산한다:

- **상류(upstream, 역방향)** = 시드를 바꾸면 깨질 수 있는 **호출자** → API·진입점·업무 흐름 영향.
- **하류(downstream, 정방향)** = 시드가 의존하는 **협력자** → DB·영속성(매퍼) 영향.

모든 사실 주장에 `파일:라인` 인용이 붙고 기계 검증(경로 실존→라인→텍스트 일치)을 통과한다. 출력 `docs/09_release/change-impact-analysis.md`는 **읽기전용 분석 산출물**(검토·승인 상태기계 밖)이다.

## 0) 전제
`/understand-map scan`이 `.spec/map/` 산출물을 만들어둬야 한다. 없으면 엔진이 안내하며 멈춘다. 도메인 흐름 영향까지 보려면 `confirm`까지 끝나 있어야 한다(아니면 흐름/도메인은 `[확인 필요]`로 강등).

## 1) 시드 매핑 — host(=너)의 역할
엔진은 **자연어를 받지 않는다.** 파일 경로 집합(`--path`)만 입력이다. 자연어 변경요청을 시드 파일로 옮기는 것은 host의 일이다:

1. 카탈로그를 받는다:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-impact.mjs <projectRoot> seeds
   ```
   라우트(routeId→handler→파일)·도메인·파일 인벤토리가 나온다.
2. 사용자의 자연어("로그인에 간편 로그인 추가")를 카탈로그로 **후보 파일**에 매핑한다.
3. **✋ 확인 게이트 (생략 불가):** 후보 파일을 사용자에게 한국어로 제시하고 *"이 파일들을 변경 시드로 보고 영향을 분석할까요?"* 확인을 받는다. **절대 임의로 진행하지 말 것.** 다의적/매핑 불가면 정확한 파일 지정을 요청한다.

## 2) 분석
확정된 시드로:
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-impact.mjs <projectRoot> analyze --path <파일> [--path <파일2> ...] [--by <핸들>]
```
산출: `.spec/map/impact.json`(결정론) + `impact-verify-report.json`(근거율) + `docs/09_release/change-impact-analysis.md`(읽기전용) + `IMPACT_ANALYZED` 감사. 한국어 요약(상류 N·API M·DB K·흐름 J·검토필요·근거율)을 사용자에게 보고한다.

> ⚠️ `--path` 없이 호출하면 엔진은 임의 분석을 하지 않고 카탈로그+안내만 낸다(fail-closed). 반드시 시드를 지정하라.

## 3) DB 테이블/컬럼 보강 — host의 역할
엔진은 **영향 매퍼 XML까지만** 결정론으로 산출하고(테이블/컬럼은 KG에 신뢰 가능한 형태로 없다), `tableCandidateSlots`에 각 매퍼의 SQL 슬라이스 위치를 닻으로 남긴다. host는:
- 그 슬라이스의 SQL 본문을 읽어 **건드리는 테이블/컬럼을 인용 의무로 추출**(`citations` ≥1).
- 추출한 테이블명을 `kgTableCatalog`(KG table 노드: 이름→schema SQL 라인범위)와 매칭해 DDL 근거를 붙인다.
- 동적 SQL(`${}`·`<include>`)로 모호하면 `[확인 필요]`로 둔다. KG `related` 엣지는 약신호이므로 사실로 단정하지 말 것.

## 4) 결과 해석 (사용자에게)
- **상류 vs 하류**를 구분해 보고: 상류=내 변경에 영향받는 호출자, 하류=내 시드가 함께 봐야 할 협력자.
- **API 영향 confidence**: `both`(ownership+reverse 일치)=`[확정(AI)]`, 단일 신호=교차검증 불일치(`[추정]`/`[확인 필요]`).
- **과도전파 투명 보고**: `overEdges.hubNodes`(공용 유틸/예외 경유)·`crossCheckDiff`·`needsReview`를 "영향이 과대 추정될 수 있는 지점"으로 그대로 보여준다.
- **흐름/도메인은 `[추정]`**: step 입도가 라우트-선언-파일 단위라 '실 호출'이 아닌 '체인 내 도달'이다.
- **비-Java 시드(JSP/TS/web.xml)**: edges가 java 기반이라 역방향이 빈약 → `[확인 필요]` 강등, host 보강 권장.

## 5) 상태
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-impact.mjs <projectRoot> status
```
마지막 분석 요약.

> 이 문서는 **읽기전용 분석물**이다 — `/understand-docs`의 5종처럼 검토·승인 상태기계에 넣지 않는다(영향 추정은 [추정] 다수). 검토·확정이 필요하면 Phase 2.
