# Step 2 — 신뢰성 체계(검토/승인/감사) + 동시성 안전장치

> 날짜: 2026-06-08 · 브랜치 `ktds/mvp-stage1` · 커밋 `9d01f5b`
> 계획: `.omc/plans/mvp-legacy-ai-docs.md` 단계3(검토/승인/감사) + 단계2 lock · 제품 3번 축(신뢰성 체계)

---

## 0. 이번에 뭘 했나 (한 줄)

문서를 **"믿어도 되는가"** 를 보장하는 4개 모듈 — 상태기계·감사로그·잠금·승인흐름 — 을 만들었다. 제품 3번 축(검토·승인·감사) + 동시 실행 안전장치.

## 1. 만든 4개 모듈 (`packages/legacy-core/src/`)

**① doc-state** — 문서 상태기계
- `DRAFT → UNDER_REVIEW → APPROVED`, 반려는 `UNDER_REVIEW → RETURNED → DRAFT`.
- **불법 전이는 거부**(예: DRAFT에서 바로 APPROVED 불가, A8). APPROVED는 종료상태.
- 상태는 `.spec/doc-status.json`에 저장.

**② audit** — 감사 로그 (append-only)
- 모든 사건을 `.spec/audit/YYYY-MM-DD.jsonl`에 한 줄씩 추가. 이벤트: `LLM_REQUEST / DOC_GENERATED / DOC_ITEM_CONFIRMED / DOC_APPROVED / RUN_ABORTED / INIT_RERUN / STALE_LOCK_REMOVED`(보안 이벤트는 Phase 2).
- 조회: 날짜 필터, 손상된 줄은 건너뜀, 시간순 정렬.

**③ lock** — 동시 실행·복구 안전장치
- `.spec/.analysis.lock`(PID·시각). 다른 분석이 **살아있는 PID로 돌고 있으면 거부**, **죽은 PID(stale)면 정리 후 인수**.
- 산출물은 `staging/`에 먼저 쓰고, 실패하면 통째로 폐기(기존 문서 불변). 단일 워크스테이션 전용(MVP).

**④ approval** — 검토/승인 흐름 (②③을 조합)
- `review`(목록·검토 시작) → `[추정]`을 담당자가 **확정**(`[확정(담당자)]`) → `approve`(승인).
- 승인 시 `approvals.json` 기록 + `DOC_APPROVED` 감사. **승인자는 핸들/이니셜만 저장(실명/사번 미저장, O3)**.

## 2. 제작 + 품질 (작성/검토 분리)

- 구현은 메인 세션이 직접(모듈 간 의존이 있어 순차가 안전).
- **독립 코드리뷰 에이전트로 검토** → 판정 **APPROVE-WITH-NITS** (CRITICAL/HIGH 0). 스펙 적합성(A7/A8/§3.5/§7.2/§7.3/O3) 확인.
- 리뷰가 짚은 **robustness 결함**을 수정:
  - 손상된 `doc-status.json`/`approvals.json`이 워크플로를 먹통으로 → **친절한 오류로 전환**
  - `approveDoc` 순서 재배치(검증→기록/감사→상태전환 **마지막**) → 중간 실패 시 APPROVED-기록없음 방지(retry 가능)
  - `isProcessAlive`가 예상 못한 오류를 "죽음"으로 오판해 락 탈취 → **예상 외 errno는 재던짐**
  - 감사 로그 시간순 정렬 + UTC 버킷 명시
- **검증:** `tsc` 통과 + **테스트 83개 전부 통과** (단계1 54 + 단계2 모듈 25 + 리뷰 회귀 4).
  - 재현: `pnpm --filter @ktds/legacy-core test`

## 3. 지금까지 누적 상태

`@ktds/legacy-core` 9개 모듈 중 **7개 구현 완료**:
| 모듈 | 상태 |
|---|---|
| config · kg-reader · evidence | ✅ (단계1) |
| doc-state · audit · lock · approval | ✅ (단계2) |
| doc-generator | ⬜ stub |
| export | ⬜ (폴더 아직 없음) |

## 4. 아직 안 된 것 (한계)

- **doc-generator**(5종 문서 렌더러)·**export**(HTML) 미구현 → 실제 문서가 나오는 단계가 빠져 있음.
- **SKILL.md 3개 명령은 여전히 껍데기** — `/understand-docs` 쳐도 엔진이 배선 안 됨.
- **end-to-end 미검증**: `config→kg-reader→evidence→doc-generator→(검토/승인/감사)→export` 전체 흐름이 실제 fixture로 도는 건 아직.
- 검토/승인/감사는 **로직·저장은 됐지만 CLI 명령과 연결 안 됨**(다음 단계).

## 5. 검증된 인수 기준

A7(DRAFT→APPROVED 전이+감사) · A8(불법 전이 거부) · §3.5(lock/stale/staging) · §7.2(승인 기록) · §7.3(감사 이벤트) · O3(승인자 PII 미저장) — 단계2 범위 충족.

## 다음(예정)

doc-generator(결정론 skeleton + LLM prose 분리) + export(HTML) + SKILL.md 배선 + **E2E 통합 테스트** → step3.md.
