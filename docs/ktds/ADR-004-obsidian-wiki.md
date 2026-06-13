# ADR-004: /understand-docs wiki — 옵시디언 호환 LLM wiki 산출 (세분화 노트 + 위키링크)

- 상태: **Accepted** — T0~T11 구현 + 독립 리뷰 3패스 완료, jpetstore E2E 검증, 사용자 실사용 피드백 반영(뷰어 통합 개정 — §8). 작성일 2026-06-13, 구현·개정 2026-06-14. 게시: ktds-legacy 0.10.0 / understand-anything 2.8.0.

> **⚠️ §8 구현 개정(2026-06-14)을 먼저 읽을 것.** 아래 §1~§7의 "주 뷰어 = `GRAPH_DIR=docs` 별도 knowledge 뷰"(ID2/ID6/ID10) 전제는 사용자 실사용 후 **폐기**되었다. 실제 구현은 **위키를 루트 `.understand-anything/wiki-graph.json`에 두고, 코드 그래프와 같은 대시보드에서 "문서" 뷰 토글로 로드 + 전용 리더 레이아웃**이다(도메인 뷰 패턴). §1~§7은 설계 의도·기각 대안의 기록으로 보존한다.
- 결정 범위: ktds-legacy-plugin (U-A fork 격리 확장). `/understand-docs`의 신규 서브커맨드 `wiki`.
- 관련: ADR-001(/understand-map — 도메인/흐름/step 원천), ADR-002(/understand-impact — filePath 조인·결정론·근거 검증 패턴 재사용), ADR-003(대시보드 ktds 소유), U-A `/understand-knowledge`(Karpathy wiki 소비자), 구현 계획 `.omc/plans/obsidian-wiki-tasks.md`

---

## 1. 배경 (Context)

### 1.1 동기 — PL이 원한 화면은 "옵시디언 + LLM wiki"

`/understand-docs`가 생성하는 5종 운영 문서(01~05)는 **거대 단일 파일**이라 탐색·연결이 약하다. PL이 실제로 원한 것은 **옵시디언 스타일**: ① 문서 간 그래프(노드 클릭 → 점프), ② 마크다운 본문 열람, ③ 백링크·로컬그래프·파일트리. 이는 Karpathy의 "LLM wiki"(마크다운 + `[[위키링크]]` + index.md) 패턴과 동일하며, **옵시디언이 그 폴더를 그대로 vault로 연다**.

### 1.2 뷰어는 대부분 이미 있다 (핵심 — 주 뷰어=웹 대시보드)

처음엔 "옵시디언(별도 앱)이 주 뷰어"로 봤으나, 코드 확인 결과 **U-A 웹 대시보드의 knowledge 뷰가 이미 옵시디언 레이아웃의 ~80%를 제공**한다 — 별도 앱 설치·실행 없이 한 웹 화면에서:

| 옵시디언 기능 | 대시보드 | 코드 근거 |
|---|---|---|
| 그래프 | KnowledgeGraphView | App.tsx:659 |
| 위키링크(나가는)·백링크(들어오는) 클릭 이동 | NodeInfo `KnowledgeNodeDetails` | NodeInfo.tsx:52,58,85-122 |
| 본문 미리보기 | 〃 | NodeInfo.tsx:123-133 |
| **문서 목록(폴더 트리)** | `Files` 탭 → FileExplorer(filePath 있는 노드로 트리, knowledge 모드 게이팅 없음) | App.tsx:428,444 / FileExplorer.tsx:30,147 |

→ **주 뷰어 = 웹 대시보드**(`/understand-knowledge`). article 노드가 `filePath`를 가지므로 우리 `00_개요/`·`feature/`·`api/`·`table/` 폴더가 Files 탭 트리로 그대로 뜬다. 옵시디언은 **같은 Karpathy 포맷이라 덤으로** 됨(별도 앱). 2026-06-13 POC로 감지·렌더 검증(index.md 1장 → 7 article+2 topic+7 edge). 4번째 뷰를 fork로 신설할 필요 없음 — 기존 knowledge 뷰 재사용.

### 1.2.1 대시보드의 진짜 갭은 본문 표시 품질뿐

옵시디언 대비 차이는 **본문 표시 2가지**로 좁혀진다 — (a) 미리보기가 `font-mono whitespace-pre-wrap` raw 텍스트라 **마크다운 미렌더**(NodeInfo.tsx:126), (b) **1500자 잘림**(NodeInfo.tsx:127). 둘 다 ADR-003(대시보드 ktds 소유) 범위의 **소규모 fork**로 해소(`ReactMarkdown`은 이미 LearnPanel.tsx에서 사용 중) → ID9.

### 1.3 재료는 이미 있다 (CanonicalGraph)

세분화 노트의 엔티티·관계는 전부 기존 그래프에 있다 — 새 정적분석 불필요(`doc-generator/index.ts` 빌더가 이미 소비):

| 계층 | 노드 kind | 상호링크 엣지 | 근거 |
|---|---|---|---|
| 기능 | `domain` / `flow` / `step` | `contains_flow`, `flow_step` | domainMeta.ktdsClaims 인용 / claimForNode |
| API | `endpoint` | `routes`, `middleware` | claimForNode(endpoint.evidence) |
| DB | `table` / `schema` | `reads_from`/`writes_to`(실 KG 0건 — ADR-002 §1.3) | claimForNode / 매퍼 슬라이스 |

기능↔API 조인은 직접 엣지가 없어 **filePath 공유 조인**(step.filePath == endpoint.filePath)으로 잇는다 — ADR-002 오버레이의 KG↔도메인 조인과 동일 기법.

### 1.4 Karpathy 파서 계약 (검증된 제약)

`/understand-knowledge`의 `parse-knowledge-base.py` 감지 게이트는 **`index.md` 존재 + .md ≥3** 둘뿐(`rglob` 재귀 → **하위 폴더·파일 증가 자동 처리**, 하위 폴더는 노드 **태그**로 변환). 위키링크는 감지 필수가 아니라 **`related` 엣지의 소스**다(없으면 섬). index.md의 `##` 섹션 = 토픽/레이어, 그 아래 `[[링크]]` = `categorized_under` 엣지.

### 1.5 jpetstore 실측 — 계층별 노트 수 (절단선 근거)

`domain` 4 · `flow` 4 · `endpoint` 6 · `table` 23 = **기본 37노트**. `step` 32(포함 시 69). `function` 81·`class` 37·`file` 66은 **위키 대상 아님**(코드 그래프 영역). domain/flow/endpoint/table은 "인터페이스 표면"(완만 증가), step만 "구현 깊이"(코드량 비례 폭증) → step이 정확한 opt-in 절단선.

---

## 2. 결정 (Decision)

**ID1.** `/understand-docs`를 위키 기본 동작으로 확장(ID7) + 서브커맨드 `wiki`(재생성). 모든 신규 코드는 `packages/legacy-core/src/wiki/` — **U-A 원본 무수정(A1) 유지**. **U-A 파서(`parse-knowledge-base.py`)·머지·LLM 경로는 우리 대시보드 경로에서 쓰지 않는다**(ID10) → 진짜 "무수정 + 미사용". 마크다운 vault는 옵시디언과 (원하면) `/understand-knowledge`가 소비하지만 우리 대시보드 표시의 정본은 ID10의 직접 emit이다.

**ID2.** 산출물은 두 가지다 — (a) **Karpathy 패턴 마크다운 vault**(`index.md` + 세분화 노트 `[[위키링크]]` + 5 허브 링크섹션) = 옵시디언/디스크 정본, (b) **결정론 `knowledge-graph.json`**(ID10) = 대시보드 정본. **주 뷰어 = U-A 웹 대시보드의 기존 knowledge 뷰**(그래프 + Files 트리 + Info 위키링크/백링크/본문, §1.2) — 새 뷰 안 만들고 재사용(ID9 본문 렌더 보강만). 옵시디언은 vault를 직접 열어 **덤**(별도 앱, 작업 0).

**읽기 제스처 명확화(F3)**: 노트 "읽기"의 정답 동선 = **노드 선택 → Info 탭**(NodeInfo, 마크다운 렌더+전체 본문, ID9). **Files 탭은 폴더 트리 탐색**(더블클릭 시 CodeViewer raw 소스 — 보조). ADR은 Files 트리를 "탐색"으로, Info를 "리더"로 명시한다(과대 표현 금지).

**ID3.** **노트 입도 = 업무·인터페이스 계층만**(`domain`/`flow`/`endpoint`/`table`). `step`은 **opt-in**(ID7). `function`/`class`/`file`은 위키 노트로 만들지 않는다 — 순수 코드 구조는 **코드 그래프(U-A 대시보드)의 영역**이라 역할이 겹치지 않게 한다.

**ID4.** **결정론 경계 = ADR-001/002 답습**. 위키 **skeleton**(노트 파일 집합·frontmatter·위키링크·근거 인용·index.md·허브 링크섹션)은 그래프에서 순수함수로 산출 → **byte-diff=0**, golden-snapshot 대상(별도 기준선). 노트 **본문 산문**만 host(Claude)가 ProseProvider로 주입(스냅샷 제외). 기존 `claimForNode`/`domainMetaClaims`/`renderClaim`/`CLAIMS_FENCE`/`CONFIDENCE_TAG`/근거 계약을 **재사용** — `[확정(AI)]`은 file:line 필수, `[추정]`/`[확인 필요]` 태그 동일 적용.

**ID5.** **상호링크 메시는 엣지에서 결정론 도출**:

| 링크 | 도출 |
|---|---|
| domain → flow | `contains_flow` 엣지 |
| flow → step | `flow_step` 엣지 |
| step/endpoint → table | `reads_from`/`writes_to`; 실 KG 0건 시 매퍼(`mybatis`/`mapper-xml`) 경유(ADR-002 §1.3) |
| endpoint ↔ flow/step (기능↔API) | **filePath 공유 조인**(step.filePath == endpoint.filePath) → 미스 시 NEEDS_REVIEW |

옵시디언 **백링크는 공짜**라 역방향 링크는 쓰지 않는다(전방 링크만 emit → 결정론·중복 0).

**ID6.** **"00_개요"는 그래프 layer/topic 그룹 — 물리 폴더 이동 아님**(사용자 결정 2026-06-13, F4 해소). 5 허브는 **`docs/0N.md` 그대로** 유지 → `doc.filename`=doc-state 상태키 불변, approval/audit/lock/export/impact/review 경로 무파급, `--no-wiki` 바이트 동일이 자명. 대시보드에선 ID10 emit이 5 허브를 `00_개요` layer(+categorized_under)로 묶어 맨 위 표시. 세분화 노트만 신규 하위 폴더(`docs/feature`·`docs/api`·`docs/table`, 상태키 충돌 없음). `index.md`는 옵시디언 편의로 `docs/` 루트에 emit(우리 대시보드 경로는 파서 미사용이라 index.md 의존 안 함). **물리 폴더 이동(T5)은 폐기** — 옵시디언에서 5개가 루트에 뜨는 건 수용(그래프/대시보드 그룹으로 충분).

**ID7.** **위키 = 기본 동작(default-on)**. `/understand-docs`는 기본으로 5종 + 위키(4계층)를 함께 산출한다(사용자 결정 2026-06-13 — opt-in에서 default-on으로 전환):
- `/understand-docs` → 5종 + 위키 **4계층**(domain/flow/endpoint/table). 5종은 **`docs/0N.md` 위치 불변**(ID6 — "00_개요"는 graph 그룹), index.md·세분화 노트·허브 링크섹션 함께 발행.
- `/understand-docs --steps` → 위 + **step 계층 포함**. step은 폭증 구간이라 **기본 미포함**, 명시적 `--steps`로만(비-TTY 포함).
- `/understand-docs --no-wiki` → **순수 5종만**(루트 `docs/0N.md`, 링크섹션 없음). 위키 도입 전과 **바이트 동일**(결정론/호환 탈출구) — 핵심 5종 골든 스냅샷은 `--no-wiki` 출력으로 유지.
- `/understand-docs wiki [--steps]` 서브커맨드 → 기존 문서 위에 위키만 **재생성/갱신**(멱등 — 나중에 step 추가 등). `wiki status`로 상태 조회.
- **허브 링크섹션**은 마커 펜스(`<!-- wiki-links -->` … `<!-- /wiki-links -->`)로 감싸 **재실행 시 중복 추가가 아니라 교체**(멱등).
- 골든 스냅샷: 위키 skeleton(default 출력)과 `--no-wiki` 5종은 **각각 별도 기준선**.

**ID8.** **CLI/SKILL 표면**: `scripts/understand-docs.mjs`(understand-map.mjs 골격: 비-TTY 안전·한국어·EPIPE·ensureBuilt 동적 import). 기본 실행 = 5종+위키(4계층). 플래그 `--steps`(step 포함)·`--no-wiki`(순수 5종). 서브커맨드 `wiki [--steps]`(위키만 재생성)·`wiki status`. `skills/understand-docs/SKILL.md`에 위키 절 추가(기본 위키 동작·`--steps`/`--no-wiki` 설명·산문 주입 계약·대시보드 열기 안내, 옵시디언은 선택). 비-TTY는 임의 step 포함 금지(명시 `--steps`만).

**ID9.** **대시보드 본문 렌더 보강 (ADR-003 대시보드 ktds 소유 범위, 소규모 fork)**: knowledge 뷰의 본문 표시를 옵시디언급으로 — (a) `NodeInfo.tsx` `KnowledgeNodeDetails` 미리보기를 raw 텍스트 → `ReactMarkdown` 렌더(LearnPanel.tsx 기존 사용 패턴 재사용), (b) `meta.content` 1500자 잘림 제거(전체 본문, 필요 시 스크롤). **전체 본문이 실제로 가능한 이유 = ID10 emit이 `knowledgeMeta.content`에 전체를 담음**(U-A 파서의 `text[:3000]` 캡을 안 거침, F2 해소). `// ktds-fork` 마커로 격리(UPSTREAM_MERGE 무수정 예외 #2 계열). **그래프·Files 트리·위키링크·백링크는 이미 동작하므로 신규 없음**. understand-anything 대시보드 파일 수정 → **understand-anything 버전 bump(5파일) + UPSTREAM_MERGE 충돌점 기록**.

**ID10.** **대시보드용 `knowledge-graph.json`을 우리가 결정론으로 직접 emit**(F2/F5/F6 동시 해소). `WikiVault`(노트+링크) → dashboard 스키마(`kind:"knowledge"`, article/topic 노드, `related`/`categorized_under` 엣지, `knowledgeMeta.content`=**전체 본문**, `layers`=계층 그룹("00_개요"/기능/API/DB), `tour`) 순수 매핑. **U-A 파서·LLM Phase 3·머지 스크립트 미사용** → (a) content 캡을 우리가 통제(전체), (b) `docs/09_release/` 리포트 등 비-노트 .md 오염 0(우리 노트만 포함), (c) LLM 비결정 재유입 0·중간파일 삭제/그래프 덮어쓰기 풋건 0. 출력 경로 = **`docs/.understand-anything/knowledge-graph.json`**(분석 대상 프로젝트 루트의 코드그래프와 별도 — 대시보드는 `GRAPH_DIR=<proj>/docs`로 기동). 마크다운 vault·`index.md`는 옵시디언/`/understand-knowledge`용으로 병행 emit(우리 대시보드 경로는 비의존).

**ID11.** **claim 헬퍼 추출(F1)**: `claimForNode`·`domainMetaClaims`·`summaryEvidence`·`renderClaim`·`edgeClaim`·`nodesOfKind`/`edgesOfType`/`byUid`는 `doc-generator/index.ts`에서 **module-private**라 직접 import 불가. → `doc-generator/claims.ts`로 **추출**해 doc-generator와 wiki가 공유(중복 구현 금지 — "동일 근거·태그" 일관성 보장). **추출 직후 5종 출력 byte-diff=0 회귀 테스트**(기존 골든 불변 가드).

---

## 3. 기각 대안 (Alternatives Considered)

| 대안 | 기각 사유 |
|---|---|
| 대시보드에 "문서" 4번째 뷰를 fork로 신설 | 불필요 — 기존 knowledge 뷰가 그래프+Files 트리+위키링크/백링크/본문을 이미 제공(§1.2). 본문 렌더만 소규모 보강(ID9) |
| 옵시디언(별도 앱)을 주 뷰어로 | 별도 설치·실행·웹 미임베드 → "웹 한 화면" 요구 불충족. 대시보드가 주, 옵시디언은 같은 포맷 덤(ID2) |
| 대시보드 graph를 U-A `/understand-knowledge`(파서+LLM+머지)로 생성 | 파서 `text[:3000]` 캡(전체 본문 불가)·LLM Phase 3 비결정·`docs/09_release/` 오염·중간파일삭제/그래프 덮어쓰기 풋건. → 우리가 결정론 직접 emit(ID10) |
| 5 허브 물리 이동(`00_개요/`) | `doc.filename`=doc-state 상태키 → approval/audit/lock/export 파급 + `--no-wiki` 바이트 동일 보장 난해. → 그래프 layer 그룹으로 대체(ID6) |
| 표준 마크다운 링크 `[x](y.md)` | 파서/옵시디언 그래프는 `[[위키링크]]`가 정석 — 표준 링크만이면 `related` 엣지 빈약(섬). 위키링크 emit |
| `function`/`class`/`file`도 노트화 | 코드 그래프 영역·폭증·역할 중복(ID3) |
| `step` 항상 포함 | 구현 깊이라 코드량 비례 폭증(jpetstore 32→대규모 수천) → opt-in(ID7) |
| 위키를 5종 생성에 강결합(항상 emit) | 5종 골든 스냅샷·"5개 그대로" 규율과 충돌 → 독립 멱등 단계(ID7) |
| 5 허브를 루트 유지(이동 안 함) | 옵시디언 폴더-우선 정렬상 granular 폴더가 5개 위로 → "맨 위 5개" 요구 불충족. `00_개요/`로 이동(ID6) |
| index.md 수기 유지 | 문서 세분화 때마다 드리프트 → 폴더 트리에서 자동 생성(T3) |
| 허브에 링크 직접 인라인(마커 없음) | 재실행 중복 추가 → 마커 펜스로 멱등 교체(ID7) |

---

## 4. 결과 (Consequences)

**얻는 것**
- **웹 한 화면**에서 그래프 + 문서목록(Files 트리) + 위키링크/백링크/본문 — 기존 knowledge 뷰 재사용, 신규 뷰 0(ID2/§1.2)
- 본문 렌더 보강(ID9)은 소규모 fork(ReactMarkdown 재사용)
- 옵시디언은 같은 포맷이라 **덤**(별도 앱, 작업 0)
- 5종과 동일 근거·태그·펜스 형식(claimForNode/renderClaim 재사용) → 일관성·감사 호환
- 위키 skeleton 결정론 → 재실행 byte-diff=0(A2/A11 정합)

**감수하는 것**
- 대규모 시스템에서 step 노트 폭증(`--steps`로만 옵트인하여 완화, 한계는 실프로젝트 재평가)
- **기본 출력이 위키 포함으로 바뀜** → 기본 골든 기준선은 위키 포함본, 순수 5종 골든은 `--no-wiki` 출력으로 분리 유지(둘 다 결정론)
- `knowledge-graph.json` 직접 emit 유지보수(머지 스크립트의 스키마 매핑 일부를 우리가 재현 — dashboard 스키마 변경 추종 필요, fingerprint 가드 대상)
- claim 헬퍼 추출 리팩터(ID11)가 doc-generator 공유 코드 수정 → 5종 골든 회귀 가드 필수
- 기능↔API filePath 조인 부정확(동적 디스패치·미스 → NEEDS_REVIEW)
- `renderClaim`은 `evidence[0]`만 표기(다중 근거 손실) — 기존 한계 답습(Phase 2 후보)

**변하지 않는 것**
- `--no-wiki` 시 5종 생성은 위키 도입 전과 **바이트 동일**(루트 경로)
- U-A **파서·머지·스킬** 무수정 — 우리는 입력 계약만 충족. **대시보드는 ADR-003로 ktds 소유**라 ID9 보강 허용(`// ktds-fork` 마커 격리)

---

## 5. 수용 기준 (W1~W8)

| ID | 기준 | 검증 |
|---|---|---|
| W1 | 산출 vault가 `/understand-knowledge` 감지(index.md+≥3) 통과·대시보드 렌더 + 옵시디언 vault로 열림(위키링크→그래프·백링크) | E2E(파서 exit0 + 대시보드 fetch + 옵시디언 수동) |
| W2 | 동일 그래프 → 위키 skeleton(노트·frontmatter·링크·근거·index.md·허브섹션) **및 `knowledge-graph.json`** byte-diff=0(산문 제외) | golden-snapshot 재실행 |
| W3 | CONFIRMED_AI 노트는 file:line 근거 동봉, `[확정(AI)]`/`[추정]`/`[확인 필요]` 태그 정확 | 근거 계약 단위 테스트 |
| W4 | 기능→API→table 메시 위키링크로 도달, 백링크 해소(unresolved 0 또는 명시) | 링크 도출 테스트 + 파서 unresolved 카운트 |
| W5 | `--no-wiki` → 5종이 위키 도입 전 기준선과 바이트 동일(루트 경로); 기본 실행은 위키 포함·step은 `--steps`로만 | 핵심 골든(--no-wiki) + 기본 골든 테스트 |
| W6 | 재실행 시 허브 링크섹션 교체(중복 0)·노트 재생성 멱등 | 멱등 테스트(2회 실행 diff=0) |
| W7 | U-A 파서·머지·스킬 diff 0; 대시보드 fork는 `// ktds-fork` 마커 격리; 경로참조 감사 완료(doc-state/approval/export/impact/review 무파손) | A1/diff 검토 + 경로 grep |
| W8 | 비-TTY 안전(임의 step 금지), 한국어, EPIPE, fail-closed | CLI smoke |
| W9 | knowledge 뷰 본문이 마크다운 렌더(raw 텍스트 아님)·전체 본문(ID10 emit이 전체 content 담음); 그래프·Files 트리·위키링크/백링크 회귀 없음 | 대시보드 수동/스냅샷 + 회귀 |
| W10 | 대시보드 `knowledge-graph.json`은 우리 emit만 포함(09_release 등 비-노트 오염 0), `/understand-knowledge` LLM 미실행, 코드그래프 미덮어씀(`docs/.understand-anything/`) | emit 단위 + E2E 노드집합 검사 |
| W11 | claim 헬퍼 추출(ID11) 후 5종 출력 byte-diff=0 | 기존 5종 골든 회귀 |

---

## 6. 결정된 정책 (사용자 확정 2026-06-13)

1. **뷰어** = **웹 대시보드 주(主)**(기존 knowledge 뷰 재사용 + 본문 렌더 소규모 fork, ID9), 옵시디언은 같은 포맷 덤. 4번째 뷰 안 만듦.
2. **위키 = 기본 동작(default-on)**. `/understand-docs`가 5종+위키(4계층) 산출. `--steps`로 step 포함, `--no-wiki`로 순수 5종.
3. **기본 세분화 깊이** = domain/flow/endpoint/table(4계층), **step은 `--steps`로만**(기본 미포함).
4. **5 허브 위치 불변** = `docs/0N.md` 유지(상태키 불변). "00_개요"는 graph layer/topic 그룹(물리 이동 없음, ID6). index.md는 옵시디언용 루트 emit.
5. **허브 연결** = 5개에 마커 펜스 링크섹션 additive(멱등 교체).
6. **탈출구** = `--no-wiki` → 위키 도입 전과 바이트 동일(5종 골든 보존).

## 7. 미결 (Open Questions)

1. 세분화 노트의 검토·확정·승인 워크플로 편입 여부(현재 5종만 doc-state) — Phase 2.
2. 옵시디언 vault 운영 가이드(WSL 경로·동기화·권장 플러그인) — OPERATOR.md 보강.
3. 대규모 시스템 step 노트 성능·가독성 — 실프로젝트 후 재평가.
4. ~~`00_개요/` 물리 이동~~ — **해소**(ID6, 사용자 결정 2026-06-13): graph layer 그룹으로 대체, 물리 이동 폐기.
5. 우리 `knowledge-graph.json`이 dashboard `validateGraph`를 모든 노드형에서 통과하는지 — T11에서 실제 로드 검증(스키마 드리프트 시 fingerprint 가드 후보).
6. 결정론 보증 범위 = **우리 emit(노트+knowledge-graph.json)**. `/understand-knowledge` LLM 경로는 미사용이라 비결정 재유입 없음(옵시디언/선택 경로에서만 해당).

---

## 8. 구현 개정 — 뷰어 통합 (2026-06-14, 사용자 실사용 피드백)

§1~§7은 "위키 그래프를 `docs/.understand-anything/knowledge-graph.json`에 두고 **별도 대시보드**(`GRAPH_DIR=<proj>/docs`)로 연다"였다. 사용자 실사용 결과 이 분리가 거부되었다 — **"코드 그래프와 같은 화면에서 보고 싶다"**. 엔진(T0~T8)은 그대로 두고 **소비 경로만** 개정했다.

### 8.1 결정 (개정)
- **R-ID1. 위키 그래프 = 루트 `<proj>/.understand-anything/wiki-graph.json`** — 코드 그래프(`knowledge-graph.json`)·도메인 그래프(`domain-graph.json`) **옆**에 별도 파일로 emit(덮어쓰지 않음). `docs/.understand-anything/` 산출은 폐기. article 노드 `filePath`는 `docs/` 접두(Files 트리·CodeViewer가 docs/ 하위 노트 해소). 마크다운 vault(`docs/**/*.md`, `index.md`)는 옵시디언용으로 그대로 유지.
- **R-ID2. "문서" 뷰 토글** — 대시보드를 `GRAPH_DIR=<proj>`(루트)로 띄우면 **코드 / 도메인 / 문서** 토글이 한 화면에. **도메인 뷰와 동일 패턴**(별도 그래프 파일을 같은 대시보드가 로드). ViewMode에 `"wiki"` 추가.
- **R-ID3. 문서 모드 = 리더 레이아웃**(그래프 아님): 가운데 그래프 대신 **문서 리더**(`WikiReader.tsx`) — 상단 메타(**카테고리·태그·연결·백링크**만, 그 외 제외) + 아래 **전체 본문**(마크다운). 선택 전엔 계층별 **목차**, 문서 열람 시 `← 목차` 복귀. 네비게이션은 우측 **"문서 폴더" 트리**(FileExplorer, 단일 클릭 선택) + 연결/백링크 칩.
- **R-ID4. 문서 모드 헤더 정리**: Diff·영향도 오버레이 토글, 코드 상세도 토글, 노드 타입 범례, `LayerLegend`(레이어) **전부 숨김**(코드/도메인 모드는 불변).
- **R-ID5. 수명** = 도메인 그래프와 동일. `/understand` 재실행이 루트 `.understand-anything/`를 재생성하면 `wiki-graph.json`도 지워지므로 `/understand-docs wiki`로 재생성(`domain-graph.json`이 `/understand-map`으로 재생성되는 것과 동형).

### 8.2 변경 파일 (대시보드 = ktds 소유, ADR-003 — merge 시 ours)
- legacy-core: `wiki/graph-emit.ts`(`pathPrefix` 옵션) · `wiki/orchestrate.ts`(루트 `wiki-graph.json`+`wiki-meta.json` emit) · `scripts/understand-docs.mjs`(타임스탬프=입력 KG analyzedAt, status/안내 경로).
- 대시보드 fork(`// ktds-fork`): `vite.config.ts`(`/wiki-graph.json` 서빙) · `store.ts`(`wikiGraph` 슬라이스·ViewMode `"wiki"`) · `App.tsx`(fetch·"문서" 토글·렌더 분기·헤더 범례 숨김·사이드바) · `KnowledgeGraphView.tsx`·`FileExplorer.tsx`·`NodeInfo.tsx`(문서 모드 wikiGraph 소스) · **`WikiReader.tsx`**(신규 리더).

### 8.3 폐기·정정된 원안 항목
- **ID2/ID6**: "주 뷰어 = `/understand-knowledge` knowledge 뷰, `GRAPH_DIR=docs`" → **폐기**. 같은 대시보드의 "문서" 토글로 대체.
- **ID9**: NodeInfo content 마크다운 fork는 유지(리더가 같은 패턴 재사용)하되, **주 표시면은 사이드바 NodeInfo가 아니라 메인 리더**.
- **ID10**: 직접 emit·결정론·전체 본문·무오염은 그대로. 출력 경로만 `docs/.understand-anything/` → **루트 `.understand-anything/wiki-graph.json`**.
- "00_개요 layer 맨 위"·근거 계약·멱등·`--no-wiki` 바이트 동일·U-A 파서/LLM 미사용은 전부 불변.

### 8.4 검증 (jpetstore E2E)
기본 37노트(domain4+flow4=feature8 / endpoint6 / table23) · `--steps` 69 · 루트에 코드(243)/도메인(40)/위키(46, article42) 3그래프 공존 · U-A `validateGraph` 통과(46n/83e, drop0) · 근거율 100% · `--no-wiki` 5종 바이트 동일 · `wiki-graph.json` 3회 멱등 · legacy-core 373 테스트 · 대시보드 빌드 clean.
