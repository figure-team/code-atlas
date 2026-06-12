# ADR-003: U-A upstream 추종 전략 개정 — 대시보드 부분 분기

- **상태:** Accepted (2026-06-12, 사용자 결정)
- **관련:** [UPSTREAM_MERGE.md](./UPSTREAM_MERGE.md)(절차), ADR-002 부록 A.3(분기의 직접 계기), 기획 `plan/01_전체기획안.md` §2.1(upstream 추종 요구 — 본 ADR로 범위 축소)

## 1. 배경 (Context)

- 기획 01 §2.1은 U-A fork의 **upstream main 추종**을 요구했고, 지금까지 "U-A 원본 무수정 + 최소 예외(마커 격리)" 규율로 지켜왔다 (예외 #1: vite config ko 1줄, 예외 #2: diff 가독성 8파일).
- 중간 점검에서 **주 사용자가 PL로 확정**되며 대시보드는 PL 워크플로(영향도 시각화·실측 비교·이후 3색/패널)로 **적극 재설계**되는 방향이 됐다. 예외 목록·마커 규율로 버티기에는 개조 폭이 커진다.
- upstream이 주는 가치는 영역별로 비대칭이다:
  - **분석 파이프라인**(`/understand` 에이전트, `packages/core` 스키마/스캐너): ktds의 KG 공급원 — 분석 품질 개선·버그픽스·스키마 진화를 계속 받는 것이 이득. 우리가 수정하지 않으므로 merge 충돌도 없음.
  - **대시보드**(`packages/dashboard`): ktds가 PL용으로 재설계 중 — upstream UI 개선은 ktds 방향과 갈수록 무관하고, merge 충돌 표면(App/store/GraphView = upstream 활성 파일)은 가장 큼.
- 배포 모델상 사용자는 ktds fork(마켓플레이스 `ktds`)를 통째로 설치하므로 upstream과의 런타임 호환 문제는 없다 — 순수하게 "upstream 개선을 얼마나 흡수할 수 있나"의 문제다.

## 2. 결정 (Decision)

**부분 분기(partial divergence):**

1. **`understand-anything-plugin/packages/dashboard/**` = ktds 소유 선언.** 자유 개조(신규 컴포넌트·locale 키·구조 변경 허용), `// ktds-fork` 마커 의무 해제(참고용으로만 유지). upstream merge 시 이 경로는 **무조건 ours**, upstream 대시보드의 개선이 필요하면 **선별 cherry-pick**.
2. **그 외(`packages/core`, `skills/`, `agents/`, 루트) = 추종 유지.** 기존 무수정 규율 그대로, KG 계약은 fingerprint 가드 + `UA_BASELINE.md`로 감시.
3. 기획 01 §2.1의 "upstream 추종"은 **분석 파이프라인 한정**으로 범위 축소 — 본 ADR이 그 결정 기록이다.

## 3. 기각 대안 (Alternatives Considered)

- **완전 포기(hard fork):** 웹·파이프라인 모두 자유지만 `/understand` 분석 품질 개선·스키마 진화를 더 못 받음. 대시보드 자유는 부분 분기로도 100% 얻으므로 추가 이득 없이 손실만 — 기각.
- **현 전략 유지(무수정+마커):** 웹 대개조 시 merge 충돌 비용이 발산(이미 8파일, 핵심 활성 파일에 걸림) — 기각.

## 4. 결과 (Consequences)

- (+) 대시보드 개조 자유: 오버레이 채널 분리(diff=실측 / 영향도=예측), 전용 토글·라벨, 향후 3색·API/DB 패널 가능.
- (+) 분석 파이프라인은 계속 upstream 개선 흡수.
- (−) upstream 대시보드 개선의 자동 흡수 포기 — 필요 시 cherry-pick 비용(수동 식별·이식).
- (−) 시간이 갈수록 대시보드는 upstream과 멀어져 cherry-pick 난도 상승 — 수용(어차피 방향이 다름).
- UPSTREAM_MERGE.md 절차 개정: merge 시 `git checkout --ours -- understand-anything-plugin/packages/dashboard`. 기존 예외 #1·#2는 대시보드 경로 안이므로 **본 결정에 흡수**(별도 재적용 불필요).
