import { promises as fs } from "node:fs";
import * as path from "node:path";
import { scanJavaFile, type JavaFileFacts } from "./java-facts.js";
import { assignRouteIds, sortBatchEntries } from "./route-key.js";
import { buildCensus } from "./census.js";
import { gitCommitHash, writeCensus, writeRoutes } from "./persist.js";
import {
  type BatchEntry,
  type CensusReport,
  type RouteEntry,
  type RoutesReport,
} from "./types.js";
import { buildSpringIndexes, extractSpringRoutes } from "./routes/spring.js";
import { buildActionBeanIndex, extractStripesRoutes } from "./routes/stripes.js";
import { extractWebXmlRoutes } from "./routes/web-xml.js";
import { extractJspRoute } from "./routes/jsp.js";
import {
  extractJavaBatchEntries,
  extractXmlBatchEntries,
} from "./routes/batch.js";
import { classifyNextJsFile, nextJsRoutesFor } from "./routes/nextjs.js";

// S2 orchestrator: census in, routes.json out. Files are processed in census
// order (already sorted) and every output array is re-sorted by natural key,
// so traversal order can never leak into the artifact (M1).

type UnassignedRoute = Omit<RouteEntry, "routeId">;

export async function extractRoutes(
  projectRoot: string,
  census: CensusReport,
): Promise<RoutesReport> {
  const routes: UnassignedRoute[] = [];
  const batchEntries: BatchEntry[] = [];
  let contextPath: string | null = null;

  // Pass 1 — parse every Java file once; all Java extractors share the facts.
  const javaFacts = new Map<string, JavaFileFacts>();
  for (const file of census.files) {
    if (file.lang !== "java") continue;
    const content = await readProjectFile(projectRoot, file.relPath);
    javaFacts.set(file.relPath, await scanJavaFile(content));
  }
  const springIndexes = buildSpringIndexes(javaFacts);
  const actionBeanIndex = buildActionBeanIndex(javaFacts);

  // Pass 2 — per-file extraction.
  for (const [relPath, facts] of javaFacts) {
    routes.push(...extractSpringRoutes(relPath, facts, springIndexes));
    routes.push(...extractStripesRoutes(relPath, facts, actionBeanIndex));
    batchEntries.push(...extractJavaBatchEntries(relPath, facts));
  }

  for (const file of census.files) {
    if (file.lang === "xml") {
      const content = await readProjectFile(projectRoot, file.relPath);
      if (path.posix.basename(file.relPath) === "web.xml") {
        routes.push(...extractWebXmlRoutes(file.relPath, content));
      }
      batchEntries.push(...extractXmlBatchEntries(file.relPath, content));
    } else if (file.lang === "jsp") {
      const route = extractJspRoute(file.relPath);
      if (route) routes.push(route);
    } else if (
      file.lang === "ts" ||
      file.lang === "tsx" ||
      file.lang === "js" ||
      file.lang === "jsx"
    ) {
      const candidate = classifyNextJsFile(file.relPath);
      if (candidate) {
        const content = candidate.needsContent
          ? await readProjectFile(projectRoot, file.relPath)
          : null;
        routes.push(...nextJsRoutesFor(file.relPath, candidate, content));
      }
    } else if (
      contextPath === null &&
      (file.lang === "properties" || file.lang === "yaml")
    ) {
      // First match in census (sorted) order — deterministic.
      const content = await readProjectFile(projectRoot, file.relPath);
      contextPath = detectContextPath(file.lang, content);
    }
  }

  const assigned = assignRouteIds(routes);
  assertUniqueIds(assigned.map((r) => r.routeId), "routeId");
  const sortedBatch = sortBatchEntries(batchEntries);
  assertUniqueIds(sortedBatch.map((b) => b.entryId), "entryId");

  return {
    schemaVersion: 1,
    gitCommit: census.gitCommit,
    contextPath,
    routes: assigned,
    batchEntries: sortedBatch,
  };
}

/** Natural-key uniqueness is a structural invariant (A15); a duplicate would silently merge two declarations downstream. */
function assertUniqueIds(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`domain-map invariant violation: duplicate ${label} "${id}"`);
    }
    seen.add(id);
  }
}

/**
 * Stage-14 entry point: full census (S1) + route/entry extraction (S2),
 * persisted to .spec/map/{census,routes}.json. Independent of /understand —
 * the KG is consulted only for the cross-check report (ADR D5).
 */
export async function scanDomainMap(projectRoot: string): Promise<{
  census: CensusReport;
  routes: RoutesReport;
  censusPath: string;
  routesPath: string;
}> {
  const census = await buildCensus(projectRoot);
  const routes = await extractRoutes(projectRoot, census);
  const censusPath = await writeCensus(projectRoot, census);
  const routesPath = await writeRoutes(projectRoot, routes);
  return { census, routes, censusPath, routesPath };
}

/**
 * Detected from Spring Boot config for the report's informational field only —
 * never folded into routeIds (A15: deployment config must not re-key flows).
 */
function detectContextPath(
  lang: "properties" | "yaml",
  content: string,
): string | null {
  const re =
    lang === "properties"
      ? /^\s*server(?:\.servlet)?\.context-path\s*[=:]\s*(\S+)\s*$/m
      : /^\s*context-path:\s*["']?([^\s"']+)["']?\s*$/m;
  const m = re.exec(content);
  return m ? m[1] : null;
}

async function readProjectFile(projectRoot: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relPath), "utf-8");
}

export { gitCommitHash };
