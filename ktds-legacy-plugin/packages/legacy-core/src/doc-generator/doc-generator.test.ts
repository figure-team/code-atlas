import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { CanonicalGraph, CanonicalNode, CanonicalEdge } from "../types.js";
import { readKnowledgeGraph } from "../kg-reader/index.js";
import {
  generateDocs, generateMarkdown, renderMarkdown, renderSkeleton,
  buildTechStack, buildArchitecture, buildFeatureSpec, buildApiSpec, buildDbSpec,
  detectCycles, nullProseProvider, type ProseProvider,
} from "./index.js";

const edge = (s: string, t: string, type: string): CanonicalEdge => ({
  sourceUid: s, targetUid: t, type, direction: "forward", weight: 1,
});

const FIXTURE = resolve(import.meta.dirname, "../../../../../fixtures/ua-sample-graph.v2_7_3.json");

const EXPECTED = ["01_tech-stack.md", "02_architecture.md", "03_feature-spec.md", "04_api-spec.md", "05_db-spec.md"];

function node(uid: string, kind: string, extra: Partial<CanonicalNode> = {}): CanonicalNode {
  return { uid, kind: kind as CanonicalNode["kind"], name: uid, summary: "s", tags: [], ...extra };
}
function graphOf(nodes: CanonicalNode[], edges: CanonicalEdge[] = [], extra: Partial<CanonicalGraph> = {}): CanonicalGraph {
  return {
    sourceVersion: "1.0.0", fingerprint: "x",
    project: { name: "p", languages: [], frameworks: [], description: "", gitCommitHash: "", configFiles: [] },
    layers: [], nodes, edges, ...extra,
  };
}

describe("generate 5 docs from the real v2.7.3 fixture", () => {
  it("produces exactly the 5 expected files", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const md = await generateMarkdown(graph);
    expect([...md.keys()].sort()).toEqual([...EXPECTED].sort());
  });

  it("tech-stack lists the project languages/frameworks", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const md = (await generateMarkdown(graph)).get("01_tech-stack.md")!;
    expect(md).toContain("# 기술 스택");
    // fixture project.languages includes "typescript"
    expect(md.toLowerCase()).toContain("typescript");
  });

  it("architecture includes the layers section", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const md = (await generateMarkdown(graph)).get("02_architecture.md")!;
    expect(md).toContain("## 레이어");
  });

  it("every rendered line that is a claim carries a confidence tag", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const md = await generateMarkdown(graph);
    const tagRe = /^\- \[(확정\(AI\)|확정\(담당자\)|추정|확인 필요)\] /;
    for (const text of md.values()) {
      for (const line of text.split("\n")) {
        if (line.startsWith("- ")) expect(line, line).toMatch(tagRe);
      }
    }
  });

  it("is deterministic — skeleton diff = 0 on repeat (A2/A11)", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const a = await generateMarkdown(graph);
    const b = await generateMarkdown(graph);
    for (const k of EXPECTED) expect(a.get(k)).toBe(b.get(k));
  });
});

describe("builders (unit)", () => {
  it("CONFIRMED_AI when the node has evidence, INFERRED when not", () => {
    const g = graphOf([
      node("Svc#m", "module", { evidence: { path: "src/Svc.ts", line: 3 } }),
    ], [], { project: { name: "p", languages: ["java"], frameworks: ["spring"], description: "", gitCommitHash: "", configFiles: [] } });
    const doc = buildTechStack(g);
    const modClaim = doc.sections.find((s) => s.heading === "모듈")!.claims[0]!;
    expect(modClaim.confidence).toBe("CONFIRMED_AI");
    expect(modClaim.evidence[0]).toEqual({ path: "src/Svc.ts", line: 3 });
    // language is project-derived → INFERRED (no file evidence)
    const langClaim = doc.sections.find((s) => s.heading === "언어")!.claims[0]!;
    expect(langClaim.confidence).toBe("INFERRED");
  });

  it("language/framework cite the build file as evidence when configFiles present (§5.2)", () => {
    const g = graphOf([], [], { project: { name: "p", languages: ["java"], frameworks: ["Spring"], description: "", gitCommitHash: "", configFiles: ["pom.xml"] } });
    const lang = buildTechStack(g).sections.find((s) => s.heading === "언어")!.claims[0]!;
    expect(lang.confidence).toBe("CONFIRMED_AI");
    expect(lang.evidence[0]).toEqual({ path: "pom.xml" });
  });

  it("api/db builders pick endpoint and table nodes", () => {
    const g = graphOf([
      node("LoginController#login", "endpoint", { evidence: { path: "Login.java", line: 42 } }),
      node("USERS", "table", { evidence: { path: "schema.sql", line: 1 } }),
    ]);
    expect(buildApiSpec(g).sections[0]!.claims[0]!.claim).toContain("LoginController#login");
    expect(buildDbSpec(g).sections[0]!.claims[0]!.claim).toContain("USERS");
  });

  it("renderMarkdown cites evidence as path:line", () => {
    const g = graphOf([node("E#x", "endpoint", { evidence: { path: "A.java", line: 9 } })]);
    const md = renderMarkdown(buildApiSpec(g));
    expect(md).toContain("근거: `A.java:9`");
  });
});

describe("cycle detection (02_architecture)", () => {
  it("flags a depends_on cycle", () => {
    const g = graphOf(
      [node("A", "module"), node("B", "module"), node("C", "module")],
      [
        { sourceUid: "A", targetUid: "B", type: "depends_on", direction: "forward", weight: 1 },
        { sourceUid: "B", targetUid: "C", type: "depends_on", direction: "forward", weight: 1 },
        { sourceUid: "C", targetUid: "A", type: "depends_on", direction: "forward", weight: 1 },
      ]
    );
    const cycles = detectCycles(g);
    expect(cycles.length).toBeGreaterThan(0);
    expect(new Set(cycles[0])).toEqual(new Set(["A", "B", "C"]));
    // and it surfaces in the doc as NEEDS_REVIEW
    const cyc = buildArchitecture(g).sections.find((s) => s.heading === "순환 의존 후보")!;
    expect(cyc.claims[0]!.confidence).toBe("NEEDS_REVIEW");
  });

  it("no cycle for a DAG", () => {
    const g = graphOf(
      [node("A", "module"), node("B", "module")],
      [{ sourceUid: "A", targetUid: "B", type: "imports", direction: "forward", weight: 1 }]
    );
    expect(detectCycles(g)).toEqual([]);
  });
});

describe("prose provider injection (LLM boundary)", () => {
  it("nullProseProvider leaves sections prose-less (deterministic skeleton)", async () => {
    const g = graphOf([node("E#x", "endpoint", { evidence: { path: "A.java", line: 1 } })]);
    const docs = await generateDocs(g, { prose: nullProseProvider });
    expect(docs.every((d) => d.sections.every((s) => !s.prose))).toBe(true);
  });

  it("a stub prose provider fills section bodies but skeleton claims are unchanged", async () => {
    const g = graphOf([node("E#x", "endpoint", { evidence: { path: "A.java", line: 1 } })]);
    const prose: ProseProvider = async (req) => `PROSE for ${req.heading}`;
    const md = (await generateMarkdown(g, { prose })).get("04_api-spec.md")!;
    expect(md).toContain("PROSE for 엔드포인트");
    expect(md).toContain("[확정(AI)]"); // claim still rendered
  });

  it("renderSkeleton omits prose even when present; renderMarkdown keeps it", () => {
    const doc = buildApiSpec(graphOf([node("E#x", "endpoint", { evidence: { path: "A.java", line: 1 } })]));
    doc.sections[0]!.prose = "SHOULD_NOT_APPEAR_IN_SKELETON";
    expect(renderSkeleton(doc)).not.toContain("SHOULD_NOT_APPEAR_IN_SKELETON");
    expect(renderMarkdown(doc)).toContain("SHOULD_NOT_APPEAR_IN_SKELETON");
  });
});

describe("edge ordering is deterministic regardless of input order (HIGH fix)", () => {
  it("edges whose source+target concat collide sort stably across permutation", () => {
    // "a"+"bc" === "ab"+"c" — the old concat comparator could not distinguish these.
    const e1 = edge("a", "bc", "depends_on");
    const e2 = edge("ab", "c", "depends_on");
    const nodes = ["a", "bc", "ab", "c"].map((u) => node(u, "module"));
    const out1 = renderSkeleton(buildArchitecture(graphOf(nodes, [e1, e2])));
    const out2 = renderSkeleton(buildArchitecture(graphOf(nodes, [e2, e1])));
    expect(out1).toBe(out2);
  });
});

describe("§2.3 edge consumption", () => {
  it("feature-spec consumes contains_flow/flow_step edges", () => {
    const g = graphOf(
      [node("DomA", "domain"), node("FlowA", "flow"), node("StepA", "step")],
      [edge("FlowA", "StepA", "flow_step"), edge("DomA", "FlowA", "contains_flow")]
    );
    const sec = buildFeatureSpec(g).sections.find((s) => s.heading.includes("흐름 단계"))!;
    expect(sec.claims).toHaveLength(2);
    expect(sec.claims.some((c) => c.claim.includes("FlowA → StepA"))).toBe(true);
  });

  it("api-spec consumes routes/middleware edges", () => {
    const g = graphOf(
      [node("Ctrl", "endpoint", { evidence: { path: "C.java", line: 1 } })],
      [edge("Ctrl", "Filter", "middleware"), edge("Ctrl", "/login", "routes")]
    );
    const sec = buildApiSpec(g).sections.find((s) => s.heading.includes("라우팅"))!;
    expect(sec.claims).toHaveLength(2);
    expect(sec.claims.some((c) => c.claim.includes("라우팅"))).toBe(true);
  });
});

describe("detectCycles — no false positives", () => {
  it("returns no cycle for a shared diamond (A→B,A→C,B→D,C→D)", () => {
    const g = graphOf(
      ["A", "B", "C", "D"].map((u) => node(u, "module")),
      [edge("A", "B", "depends_on"), edge("A", "C", "depends_on"),
       edge("B", "D", "depends_on"), edge("C", "D", "depends_on")]
    );
    expect(detectCycles(g)).toEqual([]);
  });
});
