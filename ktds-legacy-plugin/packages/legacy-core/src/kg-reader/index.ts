import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  CanonicalEdge, CanonicalGraph, CanonicalKind, CanonicalNode, Layer, ProjectMeta,
} from "../types.js";

// ── Baseline schema definition (docs/ktds/UA_BASELINE.md, A14) ───────────
// All 21 node types and 35 edge types verified in v2.7.3.
// Drift detection: warn if observed graph contains types OUTSIDE this set,
// or if required key fields are absent.

const BASELINE_NODE_TYPES = new Set([
  "article", "claim", "class", "concept", "config", "document", "domain",
  "endpoint", "entity", "file", "flow", "function", "module", "pipeline",
  "resource", "schema", "service", "source", "step", "table", "topic",
]);

const BASELINE_EDGE_TYPES = new Set([
  "authored_by", "builds_on", "calls", "categorized_under", "cites",
  "configures", "contains", "contains_flow", "contradicts", "cross_domain",
  "defines_schema", "depends_on", "deploys", "documents", "exemplifies",
  "exports", "flow_step", "implements", "imports", "inherits", "middleware",
  "migrates", "provisions", "publishes", "reads_from", "related", "routes",
  "serves", "similar_to", "subscribes", "tested_by", "transforms", "triggers",
  "validates", "writes_to",
]);

// Required fields (no `?` in UA_BASELINE.md GraphNode): must appear on every node.
const BASELINE_REQUIRED_FIELDS = ["summary", "tags"] as const;
// Optional fields: should appear on SOME nodes; checked as a set for fingerprint hashing only.
const BASELINE_OPTIONAL_FIELDS = ["filePath", "lineRange"] as const;
const BASELINE_KEY_FIELDS = [...BASELINE_REQUIRED_FIELDS, ...BASELINE_OPTIONAL_FIELDS] as const;

// ── U-A raw types (on-disk shape, UA_BASELINE.md) ─────────────────────────

interface RawNode {
  id: string;
  type: string;
  name: string;
  filePath?: string;
  lineRange?: [number, number];
  summary: string;
  tags: string[];
  complexity?: string;
  languageNotes?: string;
  domainMeta?: Record<string, unknown>;
  knowledgeMeta?: Record<string, unknown>;
}

interface RawEdge {
  source: string;
  target: string;
  type: string;
  direction: "forward" | "backward" | "bidirectional";
  description?: string;
  weight: number;
}

interface RawProject {
  name?: string;
  languages?: string[];
  frameworks?: string[];
  description?: string;
  gitCommitHash?: string;
  configFiles?: string[];
}

interface RawLayer {
  id: string;
  name: string;
  description?: string;
  nodeIds?: string[];
}

interface RawGraph {
  version: string;
  project?: RawProject;
  nodes: RawNode[];
  edges: RawEdge[];
  layers?: RawLayer[];
  tour?: unknown;
}

// ── Version + fingerprint guards ──────────────────────────────────────────

export const SUPPORTED_VERSIONS = ["1.0.0"];

/**
 * Version guard. `supported` defaults to SUPPORTED_VERSIONS but callers should
 * pass config.supportedSchemaVersions so the two cannot diverge (HIGH-3).
 */
export function checkVersion(version: string, supported: string[] = SUPPORTED_VERSIONS): void {
  if (!supported.includes(version)) {
    console.warn(
      `[kg-reader] version guard: graph.version="${version}" outside supported ${JSON.stringify(supported)}. Proceeding with caution.`
    );
  }
}

/**
 * Compute a stable structural fingerprint for the observed graph.
 * Hash covers: sorted observed node-type set + edge-type set + key fields present.
 * Stored in CanonicalGraph.fingerprint for reproducibility (A14 / A11).
 */
export function computeFingerprint(nodes: RawNode[], edges: RawEdge[]): string {
  const nodeTypes = [...new Set(nodes.map((n) => n.type))].sort();
  const edgeTypes = [...new Set(edges.map((e) => e.type))].sort();
  const keyFields = BASELINE_KEY_FIELDS.filter((f) => nodes.some((n) => f in n));
  const payload = JSON.stringify({ nodeTypes, edgeTypes, keyFields });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Structural drift check: warn if the graph contains type names outside the
 * v2.7.3 baseline, or if expected key fields are absent.
 * Does NOT throw — emits console.warn only (silent pass is forbidden, A14).
 */
export function checkFingerprint(nodes: RawNode[], edges: RawEdge[]): void {
  const unknownNodeTypes = [...new Set(nodes.map((n) => n.type))].filter(
    (t) => !BASELINE_NODE_TYPES.has(t)
  );
  const unknownEdgeTypes = [...new Set(edges.map((e) => e.type))].filter(
    (t) => !BASELINE_EDGE_TYPES.has(t)
  );
  // Only warn for required fields absent from ALL nodes; optional fields (filePath, lineRange)
  // are legitimately absent on many node types and should not trigger drift warnings.
  const missingKeyFields = BASELINE_REQUIRED_FIELDS.filter(
    (f) => nodes.length > 0 && !nodes.some((n) => f in n)
  );

  if (unknownNodeTypes.length > 0) {
    console.warn(
      `[kg-reader] fingerprint drift: unknown node types ${JSON.stringify(unknownNodeTypes)}. ` +
        `U-A schema may have changed. Update docs/ktds/UA_BASELINE.md and ADR (A14).`
    );
  }
  if (unknownEdgeTypes.length > 0) {
    console.warn(
      `[kg-reader] fingerprint drift: unknown edge types ${JSON.stringify(unknownEdgeTypes)}. ` +
        `U-A schema may have changed. Update docs/ktds/UA_BASELINE.md and ADR (A14).`
    );
  }
  if (missingKeyFields.length > 0) {
    console.warn(
      `[kg-reader] fingerprint drift: key fields absent from all nodes: ${JSON.stringify(missingKeyFields)}. ` +
        `U-A schema may have changed field names (A14).`
    );
  }
}

// ── uid derivation (plan §2.1) ────────────────────────────────────────────

/** Build a map from nodeId → container class name (incoming `contains` from a class parent). */
function buildClassContainerMap(nodes: RawNode[], edges: RawEdge[]): Map<string, string> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const containerMap = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === "contains") {
      const parent = nodeById.get(edge.source);
      if (parent?.type === "class") {
        containerMap.set(edge.target, parent.name);
      }
    }
  }
  return containerMap;
}

function candidateUid(node: RawNode, classContainerMap: Map<string, string>): string {
  const containerName = classContainerMap.get(node.id);
  if (containerName) return `${containerName}#${node.name}`;
  if (node.filePath) return `${node.filePath}#${node.name}`;
  return node.name;
}

/**
 * Resolve node ids → globally-unique uids (HIGH-1, A15).
 * Strategy: candidate = container#name (or filePath#name); colliding candidates get
 * an @lineRange[0] suffix; any *remaining* collision (equal lineRange[0], missing
 * lineRange→@0, or a real name that already equals a suffixed uid) is broken with a
 * deterministic ~k ordinal. Assignment order is sorted (not input order) so the uid
 * set is identical across re-runs even if U-A re-orders nodes (A11).
 */
function resolveUids(nodes: RawNode[], classContainerMap: Map<string, string>): Map<string, string> {
  const candidate = new Map<string, string>();
  const candCount = new Map<string, number>();
  for (const node of nodes) {
    const c = candidateUid(node, classContainerMap);
    candidate.set(node.id, c);
    candCount.set(c, (candCount.get(c) ?? 0) + 1);
  }

  // Deterministic order independent of input array order: (candidate, line start, line end, id).
  const ordered = [...nodes].sort((a, b) => {
    const ca = candidate.get(a.id)!;
    const cb = candidate.get(b.id)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    const la = a.lineRange?.[0] ?? -1;
    const lb = b.lineRange?.[0] ?? -1;
    if (la !== lb) return la - lb;
    const ea = a.lineRange?.[1] ?? -1;
    const eb = b.lineRange?.[1] ?? -1;
    if (ea !== eb) return ea - eb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const claimed = new Set<string>();
  const uidMap = new Map<string, string>();
  for (const node of ordered) {
    const c = candidate.get(node.id)!;
    let uid = (candCount.get(c) ?? 1) > 1 ? `${c}@${node.lineRange?.[0] ?? 0}` : c;
    if (claimed.has(uid)) {
      let k = 2;
      while (claimed.has(`${uid}~${k}`)) k++;
      uid = `${uid}~${k}`;
    }
    claimed.add(uid);
    uidMap.set(node.id, uid);
  }
  return uidMap;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface ReadOptions {
  /** Accepted graph data versions. Pass config.supportedSchemaVersions (HIGH-3). */
  supportedVersions?: string[];
}

/** Read a U-A knowledge-graph.json file and return a CanonicalGraph. */
export async function readKnowledgeGraph(
  graphPath: string,
  options: ReadOptions = {}
): Promise<CanonicalGraph> {
  const raw = JSON.parse(await readFile(graphPath, "utf-8")) as RawGraph;
  return parseRawGraph(raw, options);
}

/** Parse a raw U-A graph object. Useful for unit tests with inline fixtures. */
export function parseRawGraph(raw: RawGraph, options: ReadOptions = {}): CanonicalGraph {
  // Top-level shape guard (MED-3): fail loudly on truncated / wrong-shape input.
  if (
    !raw ||
    typeof raw.version !== "string" ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges)
  ) {
    throw new Error(
      `[kg-reader] malformed knowledge-graph: expected { version: string, nodes: [], edges: [] }`
    );
  }

  // Required-field guard (HIGH-2): a node missing summary/tags is schema drift,
  // not something to silently emit as a malformed CanonicalNode (A14 "no silent pass").
  for (const n of raw.nodes) {
    if (typeof n.summary !== "string" || !Array.isArray(n.tags)) {
      throw new Error(
        `[kg-reader] node "${n.id}" missing required fields (summary:string, tags:string[]) — ` +
          `possible U-A schema drift (A14). Update docs/ktds/UA_BASELINE.md.`
      );
    }
  }

  checkVersion(raw.version, options.supportedVersions);
  checkFingerprint(raw.nodes, raw.edges);

  const fingerprint = computeFingerprint(raw.nodes, raw.edges);
  const classContainerMap = buildClassContainerMap(raw.nodes, raw.edges);
  const uidMap = resolveUids(raw.nodes, classContainerMap);

  const nodes: CanonicalNode[] = raw.nodes.map((n) => {
    const node: CanonicalNode = {
      uid: uidMap.get(n.id)!,
      kind: n.type as CanonicalKind,
      name: n.name,
      summary: n.summary,
      tags: n.tags,
    };
    if (n.filePath !== undefined) {
      node.evidence = {
        path: n.filePath,
        line: n.lineRange?.[0],
      };
    }
    return node;
  });

  // Dangling-edge guard (MED-2): never leak raw ordinal ids into canonical edges.
  const unresolved = new Set<string>();
  const edges: CanonicalEdge[] = raw.edges
    .filter((e) => {
      const ok = uidMap.has(e.source) && uidMap.has(e.target);
      if (!ok) {
        if (!uidMap.has(e.source)) unresolved.add(e.source);
        if (!uidMap.has(e.target)) unresolved.add(e.target);
      }
      return ok;
    })
    .map((e) => ({
      sourceUid: uidMap.get(e.source)!,
      targetUid: uidMap.get(e.target)!,
      type: e.type,
      direction: e.direction,
      weight: e.weight,
    }));
  if (unresolved.size > 0) {
    console.warn(
      `[kg-reader] dropped edge(s) referencing ${unresolved.size} unknown node id(s): ` +
        `${[...unresolved].slice(0, 5).join(", ")}`
    );
  }

  const project: ProjectMeta = {
    name: raw.project?.name ?? "",
    languages: raw.project?.languages ?? [],
    frameworks: raw.project?.frameworks ?? [],
    description: raw.project?.description ?? "",
    gitCommitHash: raw.project?.gitCommitHash ?? "",
    configFiles: raw.project?.configFiles ?? [],
  };

  // Map each layer's raw nodeIds → uids (drop ids that resolved to nothing).
  const layers: Layer[] = (raw.layers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description ?? "",
    // map raw nodeIds → uids, drop unresolved, dedup (so the member count is distinct).
    nodeUids: [
      ...new Set(
        (l.nodeIds ?? []).map((id) => uidMap.get(id)).filter((u): u is string => u !== undefined)
      ),
    ],
  }));

  return { sourceVersion: raw.version, fingerprint, project, layers, nodes, edges };
}
