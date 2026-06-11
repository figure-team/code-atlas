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
