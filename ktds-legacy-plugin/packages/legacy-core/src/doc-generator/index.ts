import type {
  CanonicalGraph, CanonicalNode, CanonicalEdge, Claim, DocSection, Evidence, GeneratedDoc, ProjectMeta,
} from "../types.js";
import { CONFIDENCE_TAG, CLAIMS_FENCE_OPEN, CLAIMS_FENCE_CLOSE } from "../types.js";
import { NEEDS_REVIEW_MARKER } from "../domain-map/emit.js";

/**
 * doc-generator (plan §3.2 / §2.3): 5종 근거 문서 생성.
 *
 * 결정론 경계 (plan §2.2 / N-C2): 아래 build*()와 renderMarkdown()은 **결정론적
 * skeleton**(uid/근거/태그/구조)만 만든다 → golden-snapshot 대상(A2/A11).
 * 실제 산문(prose) 본문은 host CLI(Claude) 모델이 ProseProvider로 주입하며 diff
 * 대상이 아니다(근거율·태그로 검증). 테스트는 nullProseProvider로 결정론을 보장.
 */

// ── Prose 주입 경계 ─────────────────────────────────────────────────────────
export interface ProseRequest {
  docTitle: string;
  heading: string;
  claims: Claim[];
}
export type ProseProvider = (req: ProseRequest) => Promise<string>;

/** 산문 없음(skeleton-only) — 결정론 테스트/저비용 실행용 기본값. */
export const nullProseProvider: ProseProvider = async () => "";

// ── helpers ─────────────────────────────────────────────────────────────────
const byUid = (a: CanonicalNode, b: CanonicalNode) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

/** Total order over edges by (source, target, type) — returns 0 on ties (A2/A11 determinism). */
const cmpEdge = (a: CanonicalEdge, b: CanonicalEdge): number =>
  a.sourceUid < b.sourceUid ? -1 : a.sourceUid > b.sourceUid ? 1 :
  a.targetUid < b.targetUid ? -1 : a.targetUid > b.targetUid ? 1 :
  a.type < b.type ? -1 : a.type > b.type ? 1 : 0;

function nodesOfKind(graph: CanonicalGraph, ...kinds: string[]): CanonicalNode[] {
  const set = new Set(kinds);
  return graph.nodes.filter((n) => set.has(n.kind)).sort(byUid);
}
function edgesOfType(graph: CanonicalGraph, ...types: string[]): CanonicalEdge[] {
  const set = new Set(types);
  return graph.edges.filter((e) => set.has(e.type)).sort(cmpEdge);
}

/** Edge → claim carrying the SOURCE node's evidence when available. */
function edgeClaim(graph: CanonicalGraph, e: CanonicalEdge, text: string): Claim {
  const src = graph.nodes.find((n) => n.uid === e.sourceUid);
  return src ? claimForNode(src, text) : inferredClaim(text);
}

/** Node-backed claim → CONFIRMED_AI(근거 있음) / INFERRED(근거 없음). */
function claimForNode(node: CanonicalNode, text: string): Claim {
  const ev = node.evidence;
  // CONFIRMED_AI only with real path evidence (A5); ev narrows to non-undefined here.
  return ev?.path
    ? { claim: text, confidence: "CONFIRMED_AI", evidence: [ev], requires_human_review: false }
    : { claim: text, confidence: "INFERRED", evidence: [], requires_human_review: true };
}
/** Project/layer-derived claim → INFERRED(파일 근거 없음, 검토 권장). */
function inferredClaim(text: string): Claim {
  return { claim: text, confidence: "INFERRED", evidence: [], requires_human_review: true };
}

/**
 * 언어/프레임워크 claim — build/config 파일(pom.xml 등)을 근거로 인용하면 CONFIRMED_AI
 * (§5.2 파일 경로만 있어도 허용). configFiles 없으면 INFERRED로 격하.
 */
function configClaim(project: ProjectMeta, text: string): Claim {
  const path = project.configFiles[0];
  return path
    ? { claim: text, confidence: "CONFIRMED_AI", evidence: [{ path }], requires_human_review: false }
    : inferredClaim(text);
}

// ── 순환 의존 탐지 (02_architecture) ─────────────────────────────────────────
/** depends_on + imports 엣지에서 사이클에 속한 uid 집합을 결정론적으로 반환. */
export function detectCycles(graph: CanonicalGraph): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edgesOfType(graph, "depends_on", "imports")) {
    if (!adj.has(e.sourceUid)) adj.set(e.sourceUid, []);
    adj.get(e.sourceUid)!.push(e.targetUid);
  }
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0/undef=white,1=gray,2=black
  const stack: string[] = [];
  const dfs = (u: string) => {
    state.set(u, 1);
    stack.push(u);
    for (const v of (adj.get(u) ?? []).slice().sort()) {
      if (state.get(v) === 1) {
        const i = stack.indexOf(v);
        if (i >= 0) cycles.push(stack.slice(i));
      } else if (!state.get(v)) dfs(v);
    }
    stack.pop();
    state.set(u, 2);
  };
  for (const u of [...adj.keys()].sort()) if (!state.get(u)) dfs(u);
  return cycles;
}

// ── 5종 문서 빌더 (결정론 skeleton) ──────────────────────────────────────────
export function buildTechStack(graph: CanonicalGraph): GeneratedDoc {
  const langs = graph.project.languages.map((l) => configClaim(graph.project, `사용 언어: ${l}`));
  const fws = graph.project.frameworks.map((f) => configClaim(graph.project, `프레임워크/라이브러리: ${f}`));
  const modules = nodesOfKind(graph, "module").map((n) => claimForNode(n, `모듈: ${n.name} — ${n.summary}`));
  return {
    filename: "01_tech-stack.md",
    title: "기술 스택",
    sections: [
      { heading: "언어", claims: langs },
      { heading: "프레임워크 / 주요 라이브러리", claims: fws },
      { heading: "모듈", claims: modules },
    ],
  };
}

export function buildArchitecture(graph: CanonicalGraph): GeneratedDoc {
  const layerClaims = graph.layers.map((l) =>
    inferredClaim(`레이어: ${l.name} (${l.nodeUids.length}개 구성요소) — ${l.description}`)
  );
  const nodeByUid = new Map(graph.nodes.map((n) => [n.uid, n]));
  const depClaims = edgesOfType(graph, "depends_on", "imports").map((e) => {
    const src = nodeByUid.get(e.sourceUid);
    const text = `의존: ${e.sourceUid} → ${e.targetUid} (${e.type})`;
    return src ? claimForNode(src, text) : inferredClaim(text);
  });
  const cycleClaims = detectCycles(graph).map((c) => ({
    claim: `순환 의존 후보: ${c.join(" → ")} → ${c[0]}`,
    confidence: "NEEDS_REVIEW" as const,
    evidence: [],
    requires_human_review: true,
  }));
  return {
    filename: "02_architecture.md",
    title: "아키텍처",
    sections: [
      { heading: "레이어", claims: layerClaims },
      { heading: "의존 방향", claims: depClaims },
      { heading: "순환 의존 후보", claims: cycleClaims },
    ],
  };
}

// domainMeta의 항목(entities/businessRules/crossDomainInteractions)을 claim으로
// 렌더 (Stage-18.1 — 이전엔 name/summary만 소비, 리뷰 B-1). 근거는 /understand-map이
// domainMeta.ktdsClaims(passthrough)에 동봉한 파일:라인 인용에서 가져온다:
//   인용 있음 → CONFIRMED_AI / 없음 → INFERRED /
//   기계 검증 강등 마커("[확인 필요] " 접두) → NEEDS_REVIEW (마커는 떼고
//   CONFIDENCE_TAG 렌더가 다시 붙인다 — 이중 표기 방지)
function domainMetaClaims(n: CanonicalNode): Claim[] {
  const meta = n.domainMeta;
  if (!meta) return [];
  // (kind, text) 복합 키 — 종류가 다른 항목이 같은 텍스트를 가져도 근거가
  // 섞이지 않는다(리뷰 반영).
  const evidenceByKey = new Map<string, Evidence[]>();
  if (Array.isArray(meta.ktdsClaims)) {
    for (const c of meta.ktdsClaims as Array<Record<string, unknown>>) {
      if (typeof c?.text === "string" && typeof c?.kind === "string" && Array.isArray(c.citations)) {
        const ev = (c.citations as Array<Record<string, unknown>>)
          .filter((x) => typeof x?.filePath === "string")
          .map((x) => ({ path: x.filePath as string, line: x.line as number | undefined }));
        const key = `${c.kind} ${c.text}`;
        if (ev.length > 0 && !evidenceByKey.has(key)) evidenceByKey.set(key, ev);
      }
    }
  }
  const out: Claim[] = [];
  for (const [field, kind, label] of [
    ["entities", "entity", "엔터티"],
    ["businessRules", "businessRule", "업무 규칙"],
    ["crossDomainInteractions", "crossDomain", "도메인 간 상호작용"],
  ] as const) {
    const items = meta[field];
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const demoted = raw.startsWith(NEEDS_REVIEW_MARKER);
      const text = demoted ? raw.slice(NEEDS_REVIEW_MARKER.length) : raw;
      const evidence = evidenceByKey.get(`${kind} ${text}`) ?? [];
      const claimText = `${n.name} ${label}: ${text}`;
      if (demoted) {
        out.push({ claim: claimText, confidence: "NEEDS_REVIEW", evidence, requires_human_review: true });
      } else if (evidence.length > 0) {
        out.push({ claim: claimText, confidence: "CONFIRMED_AI", evidence, requires_human_review: false });
      } else {
        out.push({ claim: claimText, confidence: "INFERRED", evidence: [], requires_human_review: true });
      }
    }
  }
  return out;
}

/** domainMeta.ktdsClaims에서 summary 인용 → Evidence[] (없으면 []). */
function summaryEvidence(n: CanonicalNode): Evidence[] {
  const claims = n.domainMeta?.ktdsClaims;
  if (!Array.isArray(claims)) return [];
  for (const c of claims as Array<Record<string, unknown>>) {
    if (c?.kind === "summary" && Array.isArray(c.citations)) {
      return (c.citations as Array<Record<string, unknown>>)
        .filter((x) => typeof x?.filePath === "string")
        .map((x) => ({ path: x.filePath as string, line: x.line as number | undefined }));
    }
  }
  return [];
}

export function buildFeatureSpec(graph: CanonicalGraph): GeneratedDoc {
  const domainNodes = nodesOfKind(graph, "domain");
  // 도메인은 단일 파일 증거가 없지만(여러 파일의 묶음), /understand-map의
  // summary 인용(기계 검증 통과)이 있으면 그것이 근거다 — 없으면 INFERRED.
  const domains = domainNodes.map((n) => {
    const text = `업무 도메인: ${n.name} — ${n.summary}`;
    if (!n.evidence?.path) {
      const ev = summaryEvidence(n);
      if (ev.length > 0) {
        return { claim: text, confidence: "CONFIRMED_AI" as const, evidence: ev, requires_human_review: false };
      }
    }
    return claimForNode(n, text);
  });
  const flows = nodesOfKind(graph, "flow").map((n) => claimForNode(n, `흐름: ${n.name} — ${n.summary}`));
  // §2.3 step 노드: 코드 진입점 근거(file:line)를 살려 CONFIRMED_AI 로 렌더.
  // (contains_flow/flow_step 엣지로 표현되는 흐름-단계 포함관계의 단계 엔티티 자체)
  const stepNodes = nodesOfKind(graph, "step").map((n) => claimForNode(n, `처리 단계: ${n.name} — ${n.summary}`));
  const metaClaims = domainNodes.flatMap(domainMetaClaims);
  return {
    filename: "03_feature-spec.md",
    title: "기능 명세",
    sections: [
      { heading: "업무 도메인", claims: domains },
      { heading: "엔터티 · 업무 규칙", claims: metaClaims },
      { heading: "처리 흐름", claims: flows },
      { heading: "처리 단계", claims: stepNodes },
    ],
  };
}

export function buildApiSpec(graph: CanonicalGraph): GeneratedDoc {
  const endpoints = nodesOfKind(graph, "endpoint").map((n) => claimForNode(n, `엔드포인트: ${n.name} — ${n.summary}`));
  // §2.3: routes/middleware 엣지로 라우팅·미들웨어 관계 표현
  const routing = edgesOfType(graph, "routes", "middleware").map((e) =>
    edgeClaim(graph, e, `${e.type === "routes" ? "라우팅" : "미들웨어"}: ${e.sourceUid} → ${e.targetUid}`)
  );
  return {
    filename: "04_api-spec.md",
    title: "API 명세",
    sections: [
      { heading: "엔드포인트", claims: endpoints },
      { heading: "라우팅 / 미들웨어", claims: routing },
    ],
  };
}

export function buildDbSpec(graph: CanonicalGraph): GeneratedDoc {
  const tables = nodesOfKind(graph, "table", "schema").map((n) => claimForNode(n, `테이블/스키마: ${n.name} — ${n.summary}`));
  const nodeByUid = new Map(graph.nodes.map((n) => [n.uid, n]));
  const access = edgesOfType(graph, "reads_from", "writes_to").map((e) => {
    const src = nodeByUid.get(e.sourceUid);
    const text = `데이터 접근: ${e.sourceUid} ${e.type === "reads_from" ? "→읽기→" : "→쓰기→"} ${e.targetUid}`;
    return src ? claimForNode(src, text) : inferredClaim(text);
  });
  return {
    filename: "05_db-spec.md",
    title: "DB 명세",
    sections: [
      { heading: "테이블 / 스키마", claims: tables },
      { heading: "데이터 접근", claims: access },
    ],
  };
}

const BUILDERS = [buildTechStack, buildArchitecture, buildFeatureSpec, buildApiSpec, buildDbSpec];

// ── 렌더링 (결정론) ──────────────────────────────────────────────────────────
function renderClaim(c: Claim): string {
  const tag = CONFIDENCE_TAG[c.confidence];
  const ev = c.evidence[0];
  const cite = ev ? ` — 근거: \`${ev.path}${ev.line != null ? ":" + ev.line : ""}\`` : "";
  return `- ${tag} ${c.claim}${cite}`;
}

/** GeneratedDoc → Markdown 문자열 (skeleton 결정론; prose가 있으면 섹션 본문에 포함). */
export function renderMarkdown(doc: GeneratedDoc): string {
  const lines: string[] = [`# ${doc.title}`, "", "> 상태: DRAFT · ktds doc-generator · 근거 기반 자동 생성", ""];
  for (const s of doc.sections) {
    lines.push(`## ${s.heading}`, "");
    if (s.prose && s.prose.trim()) lines.push(s.prose.trim(), "");
    if (s.claims.length === 0) lines.push("_(항목 없음)_", "");
    else {
      // claim 영역 펜스 — prose 속 유사 불릿과 구분 (approval listInferredItems 계약)
      lines.push(CLAIMS_FENCE_OPEN);
      for (const c of s.claims) lines.push(renderClaim(c));
      lines.push(CLAIMS_FENCE_CLOSE, "");
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Deterministic skeleton render — strips LLM prose entirely. This is the
 * canonical target for golden snapshots (A2/A11); never snapshot renderMarkdown
 * output produced with a real prose provider.
 */
export function renderSkeleton(doc: GeneratedDoc): string {
  return renderMarkdown({ ...doc, sections: doc.sections.map((s) => ({ ...s, prose: undefined })) });
}

// ── 오케스트레이션 ───────────────────────────────────────────────────────────
export interface GenerateOptions {
  /** 산문 주입자 (기본: skeleton-only). */
  prose?: ProseProvider;
}

/** 5종 문서 모델 생성 (skeleton). prose 주입자가 있으면 각 섹션 본문을 채운다. */
export async function generateDocs(graph: CanonicalGraph, options: GenerateOptions = {}): Promise<GeneratedDoc[]> {
  const prose = options.prose ?? nullProseProvider;
  const docs = BUILDERS.map((b) => b(graph));
  for (const doc of docs) {
    for (const section of doc.sections) {
      const text = await prose({ docTitle: doc.title, heading: section.heading, claims: section.claims });
      if (text) section.prose = text;
    }
  }
  return docs;
}

/** 모든 문서를 filename→markdown 으로 렌더. */
export async function generateMarkdown(graph: CanonicalGraph, options: GenerateOptions = {}): Promise<Map<string, string>> {
  const docs = await generateDocs(graph, options);
  return new Map(docs.map((d) => [d.filename, renderMarkdown(d)]));
}
