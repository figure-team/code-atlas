import { z } from "zod";

// /understand-map Stage-14 artifact contracts (ADR-001 D3 S1-S2, D6).
// All artifacts live under .spec/map/ — NOT .understand-anything/ — so U-A's
// /understand Phase 7 intermediate cleanup can never delete them (ADR D6).
//
// Determinism contract (M1 / A11): these artifacts must be byte-identical
// across re-runs on the same commit. Therefore: no timestamps, no ordinals
// derived from traversal order, fixed key order (schema order = construction
// order), and every array sorted by an explicit natural key.

/** Subdirectory of .spec/ holding /understand-map intermediates + outputs. */
export const SPEC_MAP_DIR = "map";

export const CENSUS_FILENAME = "census.json";
export const ROUTES_FILENAME = "routes.json";
export const EDGES_FILENAME = "edges.json";
export const SLICES_FILENAME = "slices.json";

// ── Census (S1) ────────────────────────────────────────────────────────────

/** Source languages the census recognises. Everything else is out of scope. */
export const SOURCE_LANG_BY_EXT: Readonly<Record<string, string>> = {
  ".java": "java",
  ".kt": "kotlin",
  ".xml": "xml",
  ".jsp": "jsp",
  ".sql": "sql",
  ".properties": "properties",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".vue": "vue",
  ".py": "python",
};

export const CensusFileSchema = z.object({
  /** Project-root-relative path with forward slashes (sort key). */
  relPath: z.string(),
  lang: z.string(),
});
export type CensusFile = z.infer<typeof CensusFileSchema>;

/**
 * Two-tier KG cross-check (task 14.2): mismatches are REPORTED, never fixed —
 * the census is its own inventory, the KG is advisory (ADR D5: order-independent
 * of /understand).
 */
export const KgCrossCheckSchema = z.object({
  /** KG file nodes excluded by our filters on purpose (tests, ignored, non-source ext). */
  kgOnlyIgnored: z.array(z.string()),
  /** KG file nodes absent from census and NOT explained by any filter. */
  kgOnlyMissing: z.array(z.string()),
  /** Census files with no KG file node (KG stale or partial). */
  censusOnly: z.array(z.string()),
});
export type KgCrossCheck = z.infer<typeof KgCrossCheckSchema>;

export const CensusReportSchema = z.object({
  schemaVersion: z.literal(1),
  /**
   * HEAD commit at scan time; null outside git. Deterministic for the same
   * commit with a CLEAN worktree — untracked files are censused too, so a
   * dirty tree can yield different bytes under the same commit stamp.
   */
  gitCommit: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  files: z.array(CensusFileSchema),
  /** null when .understand-anything/knowledge-graph.json is absent. */
  kgCrossCheck: KgCrossCheckSchema.nullable(),
});
export type CensusReport = z.infer<typeof CensusReportSchema>;

// ── Routes / entry points (S2) ─────────────────────────────────────────────

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  /** Framework accepts any verb (e.g. @RequestMapping without method=, servlet). */
  "ANY",
] as const;
export const HttpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ROUTE_FRAMEWORKS = [
  "spring",
  "stripes",
  "webxml",
  "jsp",
  "nextjs",
] as const;
export type RouteFramework = (typeof ROUTE_FRAMEWORKS)[number];

export const ROUTE_KINDS = [
  /** JSON/data endpoint. */
  "api",
  /** View-rendering controller route. */
  "form",
  /** Directly addressable page resource (JSP, Next.js page). */
  "page",
  /** Raw servlet-mapping from web.xml. */
  "servlet",
] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export const RouteEntrySchema = z.object({
  /**
   * Natural key (A15 — never ordinal): "route:<METHOD> <path>", with
   * "@<relPath>" appended only when two files declare the same (method, path).
   * Stable across KG regeneration, LLM naming, and file re-ordering.
   */
  routeId: z.string(),
  method: HttpMethodSchema,
  /** Normalized path (leading "/", collapsed "//", no trailing "/" except root). */
  path: z.string(),
  /** Path exactly as declared in source, before normalization. */
  rawPath: z.string(),
  kind: z.enum(ROUTE_KINDS),
  framework: z.enum(ROUTE_FRAMEWORKS),
  /** Project-root-relative path of the declaring file. */
  filePath: z.string(),
  /** 1-based line of the declaration (route's deterministic evidence anchor). */
  line: z.number().int().positive(),
  /** "ClassName#method" when known, else null (e.g. JSP page routes). */
  handler: z.string().nullable(),
  /** Extraction provenance flags, sorted: "composed:@X", "constant:Y", "name-based-convention", "dispatcher", ... */
  notes: z.array(z.string()),
});
export type RouteEntry = z.infer<typeof RouteEntrySchema>;

export const BATCH_TRIGGERS = [
  /** @Scheduled annotation on a method. */
  "scheduled",
  /** Quartz bean definitions in Spring XML. */
  "quartz",
  /** <task:scheduled> in Spring XML. */
  "task-xml",
  /** public static void main entry point. */
  "main",
] as const;
export type BatchTrigger = (typeof BATCH_TRIGGERS)[number];

export const BatchEntrySchema = z.object({
  /** Natural key: "batch:<relPath>#<symbol>" — file + symbol, never ordinal. */
  entryId: z.string(),
  trigger: z.enum(BATCH_TRIGGERS),
  /** Cron/fixedRate expression text when declared, else null. */
  schedule: z.string().nullable(),
  filePath: z.string(),
  line: z.number().int().positive(),
  /** "ClassName#method" when known. */
  handler: z.string().nullable(),
  notes: z.array(z.string()),
});
export type BatchEntry = z.infer<typeof BatchEntrySchema>;

// ── Call-chain edges (S3, Stage-15) ────────────────────────────────────────

export const EDGE_KINDS = [
  /** Resolved import statement. */
  "import",
  /** @Autowired/@Resource/@Inject field type. */
  "injection",
  /** Plain field type resolved via import/same-package/unique candidate. */
  "field-type",
  /** Constructor parameter type (Spring constructor injection). */
  "ctor-param",
  /** class → superclass file. */
  "extends",
  /** class → implemented interface file. */
  "implements",
  /** interface → implementor (name convention *Impl/*ServiceImpl OR explicit implements). */
  "impl",
  /** Java string call "ns.id" → MyBatis mapper XML (SqlSession pattern). */
  "mybatis",
  /** Typed mapper interface (FQN == namespace) → mapper XML. */
  "mapper-xml",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const FileEdgeSchema = z.object({
  /** Project-relative path of the depending file. */
  source: z.string(),
  /** Project-relative path of the dependency. */
  target: z.string(),
  kind: z.enum(EDGE_KINDS),
  /** 1-based evidence line in source when the signal has one (imports, fields, calls). */
  line: z.number().int().positive().nullable(),
});
export type FileEdge = z.infer<typeof FileEdgeSchema>;

/** Unresolved references are REPORTED, never silently dropped (S4 미해소 큐 원칙). */
export const UnresolvedRefSchema = z.object({
  source: z.string(),
  ref: z.string(),
  reason: z.enum(["ambiguous", "not-found"]),
});
export type UnresolvedRef = z.infer<typeof UnresolvedRefSchema>;

export const EdgesReportSchema = z.object({
  schemaVersion: z.literal(1),
  gitCommit: z.string().nullable(),
  edges: z.array(FileEdgeSchema),
  unresolved: z.array(UnresolvedRefSchema),
});
export type EdgesReport = z.infer<typeof EdgesReportSchema>;

// ── Reachability slices (S4, Stage-15) ─────────────────────────────────────

export const SliceSchema = z.object({
  /** Entry file (declares one or more routes/batch entries). */
  root: z.string(),
  /** route/batch natural keys declared by this file, sorted. */
  entryIds: z.array(z.string()),
  /** Files reachable from root via edges (root included), sorted. */
  reached: z.array(z.string()),
});
export type Slice = z.infer<typeof SliceSchema>;

export const FileOwnershipSchema = z.object({
  relPath: z.string(),
  /** sole=단독 도달(그 도메인 후보) / shared=다중 도달(common 격리 후보) / unreached=미해소 큐 */
  status: z.enum(["sole", "shared", "unreached"]),
  /** Roots that reach this file, sorted. */
  owners: z.array(z.string()),
});
export type FileOwnership = z.infer<typeof FileOwnershipSchema>;

export const SlicesReportSchema = z.object({
  schemaVersion: z.literal(1),
  gitCommit: z.string().nullable(),
  depthCap: z.number().int().positive(),
  slices: z.array(SliceSchema),
  ownership: z.array(FileOwnershipSchema),
});
export type SlicesReport = z.infer<typeof SlicesReportSchema>;

export const RoutesReportSchema = z.object({
  schemaVersion: z.literal(1),
  gitCommit: z.string().nullable(),
  /**
   * Detected servlet context path (web.xml prefix mapping / server.servlet.context-path).
   * Informational only — routeId natural keys deliberately EXCLUDE it so that
   * deployment-config changes never re-key flows (A15 stability).
   */
  contextPath: z.string().nullable(),
  routes: z.array(RouteEntrySchema),
  batchEntries: z.array(BatchEntrySchema),
});
export type RoutesReport = z.infer<typeof RoutesReportSchema>;
