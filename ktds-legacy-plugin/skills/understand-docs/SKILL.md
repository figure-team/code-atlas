---
name: understand-docs
description: 근거 기반 5종 문서 생성(기술스택/아키텍처/기능명세/API명세/DB명세) + 검토/승인/감사
argument-hint: ["[projectRoot]", "[review --list | review --doc <f> | confirm --doc <f> --list | confirm --doc <f> --item <n> --by <handle> | approve --doc <f> --by <handle> | return --doc <f> | audit --list]"]
---

# /understand-docs

> ⚠️ 비민감 샘플 전용 (보안 게이트는 Phase 2).

`.understand-anything/knowledge-graph.json`(U-A `/understand` 산출)을 읽어 **근거 붙은 5종 문서**를 DRAFT로 생성한다. 흐름: lock → graph 로드(version+fingerprint 가드) → 5종 생성(staging) → 근거 검증(CONFIRMED_AI에 evidence 없으면 RETURNED) → `[추정]` 비율 게이트(block 0.6 초과 시 RUN_ABORTED) → atomic publish → DRAFT 등록 + 감사.

## 생성 (결정론 skeleton)
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/understand-docs.mjs <projectRoot> <runId>
```
이 스크립트는 **결정론 skeleton(근거·태그·구조)** 만 만든다. (최초 실행 시 엔진 자동 빌드 1회)

## LLM 산문 (이 단계는 host CLI = 너의 역할)
생성된 `docs/**/*.md` 의 각 섹션에 대해, **그 섹션의 claim 목록만 근거로** 자연스러운 설명 산문을 작성해 채운다. 규칙:
- claim에 없는 사실을 지어내지 말 것. 근거(`파일:라인`) 밖의 단정 금지.
- `[추정]`/`[확인 필요]` 항목은 추정임을 명시.
- 출력 언어는 config `outputLanguage`(ko).

## 검토 / 승인 / 감사 (엔진: doc-state·approval·audit)
- `review --list` → DRAFT 목록 + [추정]/[확정(AI)]/[확인 필요] 수
- `review --doc <f> [--by <handle>]` → DRAFT→UNDER_REVIEW; TTY면 확정 대상([추정]·[확정(AI)]) 인터랙티브 확정 → [확정(담당자)] + DOC_ITEM_CONFIRMED
- `confirm --doc <f> --list` / `confirm --doc <f> --item <n> --by <handle>` → 비대화(스크립트) 확정 — UNDER_REVIEW에서만 허용
  - **확정 대상 = [추정](근거 없음) + [확정(AI)](AI 근거 있음 → 담당자가 검증·책임 인수)**. [확정(AI)]→[확정(담당자)] 승격 시 근거(`파일:라인`) cite는 그대로 보존된다. ([확인 필요]는 확정 대상 아님)
- `approve --doc <f> --by <handle>` → UNDER_REVIEW→APPROVED, approvals.json + DOC_APPROVED (승인자는 핸들/이니셜만, 실명 미저장)
- `audit --list | --date <d>` → `.spec/audit/*.jsonl`

엔진: `@ktds/legacy-core`(orchestrator·kg-reader·evidence·doc-generator·doc-state·approval·audit·lock).
