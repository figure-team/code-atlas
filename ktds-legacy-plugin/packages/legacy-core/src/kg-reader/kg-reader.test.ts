import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { readKnowledgeGraph, parseRawGraph, checkVersion, checkFingerprint, computeFingerprint, mergeDomainGraph } from "./index.js";

const FIXTURE = resolve(
  import.meta.dirname,
  "../../../../../fixtures/ua-sample-graph.v2_7_3.json"
);

describe("readKnowledgeGraph — real v2.7.3 fixture (97 nodes / 183 edges)", () => {
  it("loads graph with correct node and edge counts", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    expect(graph.nodes).toHaveLength(97);
    expect(graph.edges).toHaveLength(183);
  });

  it("preserves source version", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    expect(graph.sourceVersion).toBe("1.0.0");
  });

  it("all node uids are unique", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const uids = graph.nodes.map((n) => n.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("uid does not use ordinal n_* format", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    for (const node of graph.nodes) {
      expect(node.uid).not.toMatch(/^n_\d+$/);
    }
  });

  it("maps filePath and lineRange to evidence", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const withPath = graph.nodes.filter((n) => n.evidence?.path);
    expect(withPath.length).toBeGreaterThan(0);
    // Nodes with lineRange have evidence.line set to lineRange[0]
    const withLine = graph.nodes.filter((n) => n.evidence?.line !== undefined);
    expect(withLine.length).toBeGreaterThan(0);
  });

  it("edges reference valid node uids", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    const uidSet = new Set(graph.nodes.map((n) => n.uid));
    for (const edge of graph.edges) {
      expect(uidSet.has(edge.sourceUid), `missing source uid: ${edge.sourceUid}`).toBe(true);
      expect(uidSet.has(edge.targetUid), `missing target uid: ${edge.targetUid}`).toBe(true);
    }
  });

  it("produces a stable fingerprint on repeated parse", async () => {
    const g1 = await readKnowledgeGraph(FIXTURE);
    const g2 = await readKnowledgeGraph(FIXTURE);
    expect(g1.fingerprint).toBe(g2.fingerprint);
  });

  it("populates project meta and layers (with nodeIds mapped to uids)", async () => {
    const graph = await readKnowledgeGraph(FIXTURE);
    expect(graph.project.languages.length).toBeGreaterThan(0);
    expect(graph.layers.length).toBeGreaterThan(0);
    const uidSet = new Set(graph.nodes.map((n) => n.uid));
    // every layer member uid resolves to a real node (raw nodeIds were mapped)
    for (const l of graph.layers) {
      for (const uid of l.nodeUids) expect(uidSet.has(uid)).toBe(true);
    }
  });
});

describe("uid derivation", () => {
  it("uses filePath#name when no class container", () => {
    const raw = {
      version: "1.0.0",
      nodes: [
        { id: "n1", type: "function", name: "doWork", filePath: "src/a.ts", summary: "s", tags: [] },
      ],
      edges: [],
    };
    const graph = parseRawGraph(raw);
    expect(graph.nodes[0]!.uid).toBe("src/a.ts#doWork");
  });

  it("uses className#name when class contains the node", () => {
    const raw = {
      version: "1.0.0",
      nodes: [
        { id: "cls1", type: "class", name: "MyService", filePath: "src/svc.ts", summary: "s", tags: [] },
        { id: "fn1", type: "function", name: "handle", filePath: "src/svc.ts", lineRange: [10, 20] as [number, number], summary: "s", tags: [] },
      ],
      edges: [{ source: "cls1", target: "fn1", type: "contains", direction: "forward" as const, weight: 1 }],
    };
    const graph = parseRawGraph(raw);
    const fn = graph.nodes.find((n) => n.name === "handle")!;
    expect(fn.uid).toBe("MyService#handle");
  });

  it("appends @lineRange[0] on uid collision", () => {
    const raw = {
      version: "1.0.0",
      nodes: [
        { id: "n1", type: "function", name: "init", filePath: "src/a.ts", lineRange: [5, 10] as [number, number], summary: "s", tags: [] },
        { id: "n2", type: "function", name: "init", filePath: "src/a.ts", lineRange: [20, 30] as [number, number], summary: "s", tags: [] },
      ],
      edges: [],
    };
    const graph = parseRawGraph(raw);
    const uids = graph.nodes.map((n) => n.uid).sort();
    expect(uids).toEqual(["src/a.ts#init@20", "src/a.ts#init@5"]);
  });
});

describe("version guard", () => {
  it("does not throw on supported version 1.0.0", () => {
    expect(() => checkVersion("1.0.0")).not.toThrow();
  });

  it("emits console.warn for unsupported version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkVersion("2.0.0");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("version guard"));
    warn.mockRestore();
  });
});

describe("fingerprint / drift detection", () => {
  it("no warning for all-baseline types", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkFingerprint(
      [{ id: "n1", type: "file", name: "a.ts", filePath: "a.ts", summary: "s", tags: [] }],
      [{ source: "n1", target: "n1", type: "imports", direction: "forward", weight: 1 }]
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns on unknown node type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkFingerprint(
      [{ id: "n1", type: "trace", name: "x", summary: "s", tags: [] }],
      []
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown node types"));
    warn.mockRestore();
  });

  it("warns on unknown edge type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkFingerprint(
      [{ id: "n1", type: "file", name: "a.ts", filePath: "a.ts", summary: "s", tags: [] }],
      [{ source: "n1", target: "n1", type: "new_edge_type", direction: "forward", weight: 1 }]
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown edge types"));
    warn.mockRestore();
  });

  it("warns when key fields (e.g. summary) absent from all nodes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Cast to bypass TS strictness for the test
    checkFingerprint(
      [{ id: "n1", type: "file", name: "a.ts" } as Parameters<typeof checkFingerprint>[0][number]],
      []
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("key fields absent"));
    warn.mockRestore();
  });

  it("computeFingerprint is stable and hex-formatted", () => {
    const nodes = [{ id: "n1", type: "file", name: "a.ts", filePath: "a.ts", summary: "s", tags: [] }];
    const edges = [{ source: "n1", target: "n1", type: "imports", direction: "forward" as const, weight: 1 }];
    const fp = computeFingerprint(nodes, edges);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(computeFingerprint(nodes, edges)).toBe(fp);
  });
});

describe("uid collision-freeness (HIGH-1 / A15)", () => {
  const mk = (id: string, name: string, lr?: [number, number]) => ({
    id, type: "function", name, filePath: "src/a.ts",
    ...(lr ? { lineRange: lr } : {}), summary: "s", tags: [] as string[],
  });
  const uids = (nodes: Parameters<typeof parseRawGraph>[0]["nodes"]) =>
    parseRawGraph({ version: "1.0.0", nodes, edges: [] }).nodes.map((n) => n.uid);
  const allUnique = (xs: string[]) => new Set(xs).size === xs.length;

  it("disambiguates collision with EQUAL lineRange[0]", () => {
    const out = uids([mk("n1", "init", [5, 10]), mk("n2", "init", [5, 99])]);
    expect(allUnique(out)).toBe(true);
  });

  it("disambiguates collision with MISSING lineRange (both would be @0)", () => {
    const out = uids([mk("n1", "init"), mk("n2", "init")]);
    expect(allUnique(out)).toBe(true);
  });

  it("a real name that equals a suffixed uid stays unique", () => {
    // candidate "src/a.ts#init" collides (count 2) → "...@5"/"...@20";
    // a third node literally named "init@5" must not clash with the suffixed one.
    const out = uids([
      mk("n1", "init", [5, 9]),
      mk("n2", "init", [20, 30]),
      mk("n3", "init@5", [1, 2]),
    ]);
    expect(allUnique(out)).toBe(true);
    expect(out).toHaveLength(3);
  });

  it("uid set is identical regardless of input node order (A11 determinism)", () => {
    const a = [mk("n1", "init", [5, 9]), mk("n2", "init", [20, 30]), mk("n3", "init", [5, 9])];
    const b = [a[2]!, a[0]!, a[1]!];
    expect(new Set(uids(a))).toEqual(new Set(uids(b)));
  });

  it("derives a uid for Korean/unicode names", () => {
    const out = uids([{ id: "n1", type: "function", name: "로그인처리", filePath: "src/인증.ts", summary: "s", tags: [] }]);
    expect(out[0]).toBe("src/인증.ts#로그인처리");
  });
});

describe("drift / malformed input is NOT silently passed (HIGH-2 / MED-3 / A14)", () => {
  it("throws when a node is missing required summary/tags (drift)", () => {
    const raw = { version: "1.0.0", nodes: [{ id: "n1", type: "weird", name: "x" } as never], edges: [] };
    expect(() => parseRawGraph(raw)).toThrow(/missing required fields/);
  });

  it("throws on a malformed top-level shape (no nodes array)", () => {
    expect(() => parseRawGraph({ version: "1.0.0" } as never)).toThrow(/malformed knowledge-graph/);
  });

  it("round-trips an empty graph cleanly", () => {
    const g = parseRawGraph({ version: "1.0.0", nodes: [], edges: [] });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe("dangling edges are dropped, not leaked as ordinal ids (MED-2)", () => {
  it("drops an edge referencing an unknown node id and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = parseRawGraph({
      version: "1.0.0",
      nodes: [{ id: "n1", type: "file", name: "a.ts", filePath: "a.ts", summary: "s", tags: [] }],
      edges: [{ source: "n1", target: "n_999", type: "imports", direction: "forward", weight: 1 }],
    });
    expect(g.edges).toHaveLength(0);
    // no canonical edge ever contains a raw ordinal id
    expect(g.edges.some((e) => /^n_\d+$/.test(e.sourceUid) || /^n_\d+$/.test(e.targetUid))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped edge"));
    warn.mockRestore();
  });
});

describe("version guard consumes configurable supportedVersions (HIGH-3)", () => {
  it("does not warn when the supplied supportedVersions includes the graph version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseRawGraph(
      { version: "1.1.0", nodes: [{ id: "n1", type: "file", name: "a", filePath: "a", summary: "s", tags: [] }], edges: [] },
      { supportedVersions: ["1.0.0", "1.1.0"] }
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("version guard"));
    warn.mockRestore();
  });

  it("checkVersion accepts a custom supported list", () => {
    expect(() => checkVersion("9.9.9", ["9.9.9"])).not.toThrow();
  });
});

describe("domainMeta passthrough + domain-graph 병합 (Stage-18.1)", () => {
  const rawNode = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
    id, type, name: id, summary: "s", tags: [], ...extra,
  });

  it("parseRawGraph가 domainMeta를 CanonicalNode로 보존한다 (리뷰 B-1)", () => {
    const g = parseRawGraph({
      version: "1.0.0",
      nodes: [rawNode("d1", "domain", { domainMeta: { entities: ["Order"] } })],
      edges: [],
    } as never);
    expect(g.nodes[0].domainMeta).toEqual({ entities: ["Order"] });
  });

  it("mergeDomainGraph: 자연키 id가 그대로 uid가 되고 엣지가 병합된다", () => {
    const base = parseRawGraph({ version: "1.0.0", nodes: [rawNode("n_1", "file", { filePath: "A.java" })], edges: [] } as never);
    const { graph, merged } = mergeDomainGraph(base, {
      version: "1.0.0",
      nodes: [
        rawNode("domain:order", "domain", { domainMeta: { entities: [] } }),
        rawNode("flow:POST /orders", "flow", { filePath: "A.java", lineRange: [7, 7] }),
      ],
      edges: [
        { source: "domain:order", target: "flow:POST /orders", type: "contains_flow", direction: "forward", weight: 1 },
      ],
    });
    expect(merged).toBe(2);
    const flow = graph.nodes.find((n) => n.uid === "flow:POST /orders")!;
    expect(flow.evidence).toEqual({ path: "A.java", line: 7 });
    expect(graph.edges.some((e) => e.sourceUid === "domain:order" && e.type === "contains_flow")).toBe(true);
    // base는 비파괴
    expect(base.nodes).toHaveLength(1);
  });

  it("mergeDomainGraph 멱등: 같은 그래프 재병합 → 충돌 전부 건너뜀", () => {
    const base = parseRawGraph({ version: "1.0.0", nodes: [], edges: [] } as never);
    const domainRaw = {
      version: "1.0.0",
      nodes: [rawNode("domain:order", "domain")],
      edges: [],
    };
    const once = mergeDomainGraph(base, domainRaw);
    const twice = mergeDomainGraph(once.graph, domainRaw);
    expect(twice.merged).toBe(0);
    expect(twice.skipped).toEqual(["domain:order"]);
    expect(twice.graph.nodes).toHaveLength(1);
  });
});
