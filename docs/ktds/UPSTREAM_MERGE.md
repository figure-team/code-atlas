# Upstream Merge 가이드 (follow-main)

> ktds는 `Lum1104/Understand-Anything`의 fork다. ktds 코드는 격리 추가물이므로 upstream을 계속 추종한다. plan §1 D1a.

## 원칙
- **U-A 코드/스킬 파일은 수정하지 않는다** (원본 보존, A1). ktds 로직은 전부 격리 디렉터리에만:
  - `ktds-legacy-plugin/` (플러그인·스킬)
  - `ktds-legacy-plugin/packages/legacy-core/` (엔진)
  - `fixtures/`, `docs/ktds/`
- 통합은 U-A 내부 TS API import가 아니라 on-disk `knowledge-graph.json` 계약을 통한다.

## 소유 경계 (ADR-003, 2026-06-12 개정)

- **대시보드(`understand-anything-plugin/packages/dashboard/**`) = ktds 소유 (분기).** 자유 개조 — 마커 의무 없음(기존 `// ktds-fork` 주석은 참고용). upstream merge 시 이 경로는 **무조건 ours**, 필요한 upstream UI 개선만 선별 cherry-pick. (과거 "무수정 예외 #1 vite ko 1줄, #2 diff 가독성 8파일"은 이 경로 안이므로 본 결정에 흡수 — 더 이상 개별 추적하지 않는다.)
- **그 외(`packages/core`, `skills/`, `agents/`, 루트) = upstream 추종 (무수정).** KG 계약은 fingerprint 가드 + `UA_BASELINE.md`로 감시.

## 알려진 merge 충돌점 (additive 2곳)
ktds가 손대는 upstream 매니페스트는 **2개**(둘 다 additive):
1. `pnpm-workspace.yaml` — `ktds-legacy-plugin/packages/*`, `ktds-legacy-plugin` glob 추가
2. `.claude-plugin/marketplace.json` — `plugins[]`에 `ktds-legacy` 항목 추가

upstream merge 시 1·2는 additive 라인 재적용, 대시보드 충돌은 전부 ours(아래 절차).

**대시보드 위키 "문서" 뷰 fork (ADR-004 §8, 2026-06-14)** — 모두 대시보드 경로라 ADR-003 ours 규칙으로 자동 커버(개별 추적 의무 없음, `// ktds-fork` 주석은 참고용): `store.ts`(wikiGraph·ViewMode "wiki") · `App.tsx`(/wiki-graph fetch·"문서" 토글·렌더 분기·헤더 범례 숨김) · `KnowledgeGraphView`·`FileExplorer`·`NodeInfo`(문서 모드 wikiGraph 소스) · `WikiReader.tsx`(신규) · `vite.config.ts`(`/wiki-graph.json` 서빙 — impact-overlay 패턴과 동일). 입력 계약: ktds가 `<proj>/.understand-anything/wiki-graph.json`을 emit하면 대시보드가 "문서" 토글로 로드(domain-graph.json과 동형 — upstream 무관).

## 절차
```bash
git fetch upstream
git merge upstream/main
# 대시보드는 ktds 소유(ADR-003) — 충돌 여부와 무관하게 우리 것 유지:
git checkout --ours -- understand-anything-plugin/packages/dashboard
git add understand-anything-plugin/packages/dashboard
# 나머지 충돌은 위 2개 매니페스트(additive 재적용)로 한정. 해결 후:
pnpm install
pnpm -r build && pnpm -r test    # ktds + U-A 빌드/테스트
pnpm --filter @understand-anything/dashboard build   # 분기 대시보드 빌드 확인
# 스키마 드리프트 점검 (A14): kg-reader fingerprint 가드가 UA_BASELINE과 비교
#   불일치 시 docs/ktds/UA_BASELINE.md 갱신 + kg-reader 매핑 조정 + ADR
# upstream 대시보드에 원하는 개선이 있으면 별도 cherry-pick:
#   git log upstream/main -- understand-anything-plugin/packages/dashboard 로 식별 후 수동 이식
```

## v2.7.3 고정의 범위
- 런타임은 fork HEAD(=추종된 main)를 따른다. **v2.7.3는 테스트 fixture/baseline 기준선으로만** 고정(`fixtures/ua-sample-graph.v2_7_3.json`, `UA_BASELINE.md`).
