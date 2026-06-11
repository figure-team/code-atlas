# ADR-001: /understand-map — 도메인/기능 분석의 자체 생산자 신설

- 상태: **승인 (Accepted)** — Stage-14~18 구현 완료, M1~M7 전부 그린 (2026-06-11)
- 작성일: 2026-06-11
- 결정 범위: ktds-legacy-plugin (U-A fork 격리 확장)
- 관련: `.omc/plans/mvp-legacy-ai-docs.md` (A1~A19), `docs/ktds/TROUBLESHOOTING.md:73`, `step-explanation/step6.md`·`step7.md`, 구현 계획 `.omc/plans/understand-map-tasks.md`

---

## 1. 배경 (Context)

### 1.1 03_feature-spec 공급 갭 (실측)

- `buildFeatureSpec`(doc-generator)은 `domain`/`flow`/`step` 노드를 소비하도록 구현·테스트 완료 상태이나, **표준 `/understand`는 그 노드를 생성하지 않고**, U-A `/understand-domain`은 결과를 **별도 파일 `domain-graph.json`에 저장**하며, ktds 입력은 `knowledge-graph.json` 단일 고정(orchestrator)이다. → 새 프로젝트에서 `/understand` + `/understand-docs`만 실행하면 **03_feature-spec은 "(항목 없음)" 빈 문서**가 된다 (step6 실측).
- step7에서 domain-graph를 knowledge-graph에 **ad hoc 병합**(243→276노드)해 해결했으나, 이 병합을 수행하는 **영속 모듈이 없다** (ktds 코드 전체에 domain-graph 참조 0건 — grep 검증; TROUBLESHOOTING.md:73은 이 *증상*("domain-analyzer 미실행 시 feature-spec 비어 있음")을 운영 팁으로 기록할 뿐, 영속 모듈 부재는 step6/7 구현 로그로 확인). `~/ktds-demo-proj`가 동작하는 것은 그때 병합된 KG가 디스크에 남아 있기 때문이다.

### 1.2 U-A /understand-domain의 품질 한계 (실측)

| 한계 | 근거 |
|---|---|
| evidence가 선택사항 | step의 `filePath`/`lineRange`만 존재(optional), 프롬프트가 "특정 못 하면 생략" 허용(domain-analyzer Rule 5); domain/flow 노드엔 앵커 필드 자체가 없음 |
| 검증이 형식뿐 | `validateGraph`에 파일시스템 접근 0줄 — 경로 실존·lineRange 유효성·flow-step 연결 미검증(환각 경로 통과) |
| 입력 샘플링 | extract-domain-context.py: entry 200개·시그니처 40파일·512KB 캡 |
| LLM 1회 단독 식별 | 도메인 식별·명명·businessRules·cross_domain 전부 LLM, 결정론 검증 단계 없음 |
| 실측 천장 | step7 최선 보강 후에도 feature-spec [추정] **36%**(5종 중 최악, 타 문서 0~15%) — per-doc 근거율 95%(A3)·재실행 skeleton diff=0(A11)과 구조적 충돌 |

### 1.3 문헌·업계 근거 (2026-06 조사, 출처는 조사 결과 파일 참조)

- 자동 도메인 경계 추출의 전문가 일치율 상한: **MoJoFM ~56%**(ACDC/ARC, 30년 연구), Mono2Micro 실무자 **31.8%가 수동 수정** → ✋사람 게이트는 생략 불가.
- LLM은 명명·합성에 강하나 **전수성·실행 간 일관성·근거에 구조적으로 실패**(동일 설정 실행 간 정확도 최대 15% 변동, arXiv 2408.04667).
- 업계 수렴: 결정론 정적분석이 구조 SSoT, LLM은 번역 — RIG(+12.2%), CodeWiki(+4.73pp vs RAG), Sourcegraph(임베딩 폐기→코드 그래프), IBM watsonx Z.
- 대체재 전수 조사 결과: 디렉토리 기반 분류·tree-sitter 콜체인·자체 라우트 추출 모두 **교체 가치 있는 기성품 부재** 확인. JVM 정밀 파서(JavaParser/Spoon/Joern)는 실제 단절 지점(MyBatis XML·문자열 네임스페이스·JSP·DI)을 못 풀고 패키징(JVM)·폐쇄망 게이트 위반. OWASP Noir는 Java HTTP 열거 정밀도 우위이나 Windows 미배포·jwork류/Stripes/배치 미지원 — 부분 차용만.

---

## 2. 결정 (Decision)

**D1.** ktds-legacy-plugin에 신규 명령 **`/understand-map`**(가칭)을 신설한다. 모든 신규 코드는 `ktds-legacy-plugin/packages/legacy-core/src/domain-map/`(가칭) — **U-A 원본 무수정(A1) 유지**. (이하 경로는 `ktds-legacy-plugin/` 기준 약식 표기.)

**D2.** 출력은 **U-A `domain-graph.json` 호환 스키마**(domain/flow/step + domainMeta, contains_flow/flow_step/cross_domain)를 그대로 따른다 — **"스키마는 차용, 생산자만 교체"**. U-A 대시보드 도메인 뷰와 `buildFeatureSpec`의 **domain/flow/step 노드 골격 소비**는 무수정 재사용한다. 단 **domainMeta(entities/businessRules)의 03 문서 표면화는 별도 수정 필요** — 현재 kg-reader는 domainMeta를 CanonicalNode로 매핑하지 않고 buildFeatureSpec은 name/summary만 렌더하므로, kg-reader CanonicalNode 확장 + buildFeatureSpec 섹션 추가가 D4 병합 로더와 함께 ktds 측 작업에 포함된다. 스키마 밖 데이터(step→function 매핑 등)는 ktds 중간산출물에만 보관한다.

**D3.** 파이프라인 = **결정론 skeleton → ✋사람 게이트 → LLM 빈칸 채움 → 기계 검증 → 병합**:

| 단계 | 담당 | 내용 |
|---|---|---|
| S1 | 스크립트 | **전수 census** — git ls-files ∩ 소스 필터(샘플링 금지). KG 존재 시 교차검증(불일치는 보고만) |
| S2 | 스크립트 | **라우트/엔트리포인트 전수 추출** — tree-sitter + 프레임워크 시그널(Spring 속성형·클래스+메서드 결합·web.xml·JSP·@Scheduled 배치), 캡 없음 |
| S3 | 스크립트 | **간선 수집+해소** — tree-sitter import/호출 + 인터페이스→`*Impl` 이름규약 + MyBatis `<mapper namespace>` 인덱스 + 동일패키지 무-import class_index 폴백 + `@Autowired`/`@Resource` 필드 타입 시그널 |
| S4 | 스크립트 | **도달성 묶기** — 엔트리별 BFS: 단독 도달=그 도메인 / 다중 도달=common 격리 / 잔여 고아=파일명 prefix 폴백(Anquetil–Lethbridge식 토큰화) / 그래도 남으면 "미해소 큐" |
| S5 | 스크립트 | **디렉토리 신호**(relPath LCP+과반하강, 퇴화 감지 분기)와 교차 검증 — 어긋나는 파일은 모호 큐 |
| S6 | 스크립트 | **skeleton 조립** — flow ID는 **(method, path) 라우트 자연키**(A15 정합 — KG 재생성·LLM 명명과 무관하게 안정), flow_step weight 단조증가 규칙 코드 산출, 노드/엣지 정렬·키순서 고정 직렬화. 의미 필드는 빈칸 |
| S7 | ✋사람 | **도메인 경계 확정 게이트** — 후보 표(파일 수·엔트리 수·모호 목록) 제시 → 병합/분할/개명 → `domain-plan.confirmed.json` 영속(재실행의 결정론 닻). `--auto-approve` 지원. 비-TTY는 Stage-12f 패턴 준수 |
| S8 | LLM | **빈칸 채움** — 도메인당 1 디스패치, name/summary/domainMeta(entities·businessRules·crossDomainInteractions)만. 모든 사실 주장에 `파일:라인` 인용 + 인용 라인 스니펫 동봉 의무. 노드 ID·엣지·step 순서·filePath는 read-only(변경 시 기각) |
| S9 | 스크립트 | **기계 검증** — 인용 경로 실존 + lineRange interval + 스니펫↔실파일 텍스트 일치. 실패 항목은 삭제가 아닌 NEEDS_REVIEW 강등. per-doc 근거율 리포트 산출 |
| S10 | 스크립트 | `domain-graph.json` emit + 생성 시점 **KG fingerprint·commit hash 기록**(freshness 대조용) |

**D4.** **병합 로더**: orchestrator가 `domain-graph.json` 존재 시 CanonicalGraph에 병합하는 스텝을 추가한다(ktds 측 수정 1곳 — "하류 함수 무수정 + 로더 병합 1곳 추가"). `/understand-docs` preflight가 domain 노드 부재를 감지하면 `/understand-map` 실행을 안내한다(현재의 조용한-빈-문서 갭 해소).

**D5.** U-A 의존은 **on-disk 계약만**: `knowledge-graph.json`은 존재 시 명명 재료·교차검증으로 활용(필수 아님 — `/understand`와 실행 순서 무관). U-A 내부 스크립트(`extract-structure.mjs` 등) 재호출 금지 — kg-reader 격리 원칙(A17 정신)과 동일 기준.

**D6.** **작업 디렉토리 분리**: 중간산출물은 `.spec/map/`에 쓴다 — U-A `/understand` Phase 7이 `.understand-anything/intermediate/`를 trash로 옮기는 동작과의 충돌 회피. 영속물: `domain-plan.confirmed.json`, census.

**D7.** **speclinker 패턴 차용**(원작자 사용 허락 확보, 2026-06-11): scan_source 라우트 시그널, LCP+과반하강, Impl/MyBatis 해소, 디스패치 멱등·폴백, 라우트 자연키 커버리지, freshness 경고. TS 재구현 기준(원 코드는 Python/JS 혼재). OWASP Noir의 MIT 테스트 픽스처는 라우트 추출기 검증 케이스로 차용.

**D8.** **구현 순서**: S2 라우트 census → S3 콜체인 → S4-5 도메인 분류. (뒤 단계가 앞 단계 출력을 분모/입력으로 사용 — 비판 검증 지적 반영.)

---

## 3. 기각 대안 (Alternatives Considered)

| 대안 | 기각 사유 |
|---|---|
| U-A /understand-domain 의존 + 병합만 | [추정] 36% 천장(실측), LLM 비결정이 skeleton 침투(A11 위반), evidence 무검증. **단 부트스트랩·폴백 경로로는 보존**(병합 로더는 공용) |
| U-A `extract-structure.mjs` 재호출 | 미문서 내부 스크립트 의존 — "on-disk 계약만 읽는다"는 격리 원칙(A1 원본보존·A17의 정신 — A17 자체는 alias 맵 한정) 위배. follow-main 드리프트 무방비 |
| JVM 정밀 파서 (JavaParser/Spoon/Joern) | 실제 단절 지점(MyBatis·JSP·DI) 미해결 — 교체해도 차별 휴리스틱 재구현 필요. JVM 패키징(Node+Python 전제 위반)·폐쇄망·성능 리스크. Joern은 내부가 JavaParser라 상한 동일 |
| OWASP Noir 전면 채택 | Windows 릴리스 자산 없음, jwork류 `*.do` XML 매핑·Stripes·배치/스케줄러 미지원. → MIT 픽스처 차용 + (후속) Linux/CI 한정 교차검증 오라클로만 |
| Leiden 등 커뮤니티 검출 주신호 | 입력 미세변화에 파티션 불안정, 클러스터 무명, MyBatis 단절로 입력 그래프 부실 |
| `/understand`와 병렬 실행 래퍼 | 절감 ~1-2분뿐 vs 동시 쓰기 충돌(U-A trash 정리)·인터랙티브 게이트 충돌. → **순차 thin orchestrator**(`/understand-all`, 게이트 선행 배치)는 후속 옵션 |
| LLM 단독 도메인 식별 (U-A 방식 유지) | 문헌상 최약 형태 — 비결정·근거 비강제·샘플링 누락 |

---

## 4. 결과 (Consequences)

**얻는 것**
- step의 `filePath:lineRange`가 결정론으로 자동 부착 → **근거율의 최대 지분이 LLM을 거치지 않음** (A3 충족 경로)
- skeleton이 LLM 이전에 100% 확정 → **재실행 diff=0이 검증 목표가 아니라 구성상 보장** (A11)
- `/understand`와 순서 무관 독립 실행·단독 재실행 (콜드 프로젝트에서 도메인 분석만 가능)
- 대시보드 도메인 뷰 무료 호환 — 웹과 03 문서가 같은 domain-graph.json을 읽어 **불일치 원천 차단**
- 03 공급 갭(step6 실측 — TROUBLESHOOTING.md:73의 증상) 영구 해소

**감수하는 것**
- 자체 스캐너 유지보수 (tree-sitter 그램마·프레임워크 시그널 — MVP는 Java/Spring/MyBatis 집중)
- 인벤토리 이원화 (자체 census vs KG — 교차검증 보고로 완화)
- 신규 모듈 테스트 부채 (vitest 코로케이션 컨벤션 준수)

**변하지 않는 것**
- `/understand`는 여전히 4종 문서(기술스택/아키텍처/API/DB)의 원천 — 대체하지 않는다

---

## 5. 수용 기준 (이 ADR 추가분 — 기존 A 기준 연동)

| ID | 기준 | 검증 |
|---|---|---|
| M1 | 동일 commit + confirmed 고정 + 동일 KG에서 2회 실행 → domain-graph skeleton 필드(ID/엣지/순서/filePath/lineRange/weight) diff=0 | golden snapshot (A11 확장) |
| M2 | 03_feature-spec per-doc 근거율 ≥95%(A3) + [추정] ≤15% (step7 기준선 36% 대비) | fixture E2E |
| M3 | step evidence 인용 실존율 100% (기계 검증 통과분 기준) | S9 리포트 |
| M4 | 50K LOC: 결정론 구간(S1~S6) <1분, LLM 구간 <3분 | perf 계측 (A10 정합) |
| M5 | 이질 2스택 fixture — Java Spring(전 단계) + Next.js(도메인 분류까지) | 회귀 테스트 |
| M6 | 자체 생성 domain-graph.json의 U-A 대시보드 도메인 뷰 렌더 무결성 | fixture 1회 검증 |
| M7 | U-A 원본 diff 0 | A1 |

---

## 6. 미결 (Open Questions)

1. 명령 네이밍 확정: `understand-map` vs `understand-domains` (U-A `/understand-domain`과의 혼동 방지 관점)
2. E2E 5분 게이트(A10)에서 `/understand-map` 시간의 포지셔닝 — 별도 측정인지 E2E 포함인지 (기획 명시 없음)
3. jwork류 XML 액션매핑 시그널의 구현 우선순위 — 대상 고객 코드 확보 후 결정
4. domain-graph.json 스키마의 upstream 드리프트 가드 — fingerprint 가드(A14)의 도메인 경로 확장 시점
