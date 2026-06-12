# ktds Legacy 문서 자동화 — 문서 색인

> ⚠️ **MVP는 비민감 샘플 전용** (보안 게이트는 Phase 2).

## 운영 매뉴얼
- [INSTALL.md](./INSTALL.md) — 설치 가이드 (온라인/오프라인, 전제 조건, **플러그인 업데이트·삭제**, upstream 추종)
- [OPERATOR.md](./OPERATOR.md) — 운영자 매뉴얼 (전체 흐름, 명령 레퍼런스, config, 검토/승인/감사)
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — 장애 대응 (실제 에러 메시지별 원인·대응)

## 기술 레퍼런스
- [ADR-001-understand-map.md](./ADR-001-understand-map.md) — `/understand-map` 결정 기록 (결정론 skeleton → ✋게이트 → LLM 채움 → 기계 검증 → 병합, 수용 기준 M1~M7 — **Accepted**)
- [ADR-002-understand-impact.md](./ADR-002-understand-impact.md) — `/understand-impact` 변경 영향도 결정 기록 (역/정 도달성으로 API/DB/흐름/연관모듈 영향 결정론 산출 + 인용 검증, 읽기전용 분석물, 수용 기준 N1~N7 — **Accepted**)
- [UA_BASELINE.md](./UA_BASELINE.md) — U-A v2.7.3 검증된 노드/엣지 타입·필드 (kg-reader 기준)
- [UPSTREAM_MERGE.md](./UPSTREAM_MERGE.md) — U-A fork upstream 추종 절차

## 기획서 (상위)
- [`plan/02_MVP기획안.md`](../../plan/02_MVP기획안.md) · [`plan/01_전체기획안.md`](../../plan/01_전체기획안.md)
- 작업 계획: [`.omc/plans/mvp-legacy-ai-docs.md`](../../.omc/plans/mvp-legacy-ai-docs.md)
- 단계별 진행 설명: [`step-explanation/`](../../step-explanation/)
