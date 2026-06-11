import { normalizePath } from "../route-key.js";
import type { HttpMethod, RouteEntry } from "../types.js";

// S2 Next.js file-based routing (task 14.3 — 2-stack readiness, M5). Ports
// speclinker inferFileBasedRoutes: App Router (page.*/route.*, route groups,
// catch-alls) + Pages Router (api/ prefix, index collapse).

type UnassignedRoute = Omit<RouteEntry, "routeId">;

const NEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const HANDLER_EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;

export interface NextJsCandidate {
  router: "app" | "pages";
  /** True for app-router route.* files — handler methods come from exports. */
  needsContent: boolean;
  urlPath: string;
  isApi: boolean;
}

/** Classify a file; null when it is not a Next.js route file. */
export function classifyNextJsFile(relPath: string): NextJsCandidate | null {
  const ext = relPath.slice(relPath.lastIndexOf("."));
  if (!NEXT_EXTS.has(ext) || relPath.endsWith(".d.ts")) return null;

  const segments = relPath.split("/");
  const fileName = segments[segments.length - 1];
  const stem = fileName.slice(0, fileName.lastIndexOf("."));

  // Try markers right-to-left and keep the first interpretation that yields a
  // route. A single "last marker wins" pick silently loses pages/app/… files:
  // the inner app/ marker classifies "dashboard.tsx" as a non-route app file
  // even though the pages router serves it (review finding).
  const markers: Array<{ idx: number; router: "app" | "pages" }> = [];
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === "app") markers.push({ idx: i, router: "app" });
    else if (segments[i] === "pages") markers.push({ idx: i, router: "pages" });
  }
  for (let k = markers.length - 1; k >= 0; k--) {
    const candidate = classifyWithMarker(segments, stem, markers[k].idx, markers[k].router);
    if (candidate) return candidate;
  }
  return null;
}

function classifyWithMarker(
  segments: string[],
  stem: string,
  markerIdx: number,
  router: "app" | "pages",
): NextJsCandidate | null {
  const middle = segments.slice(markerIdx + 1, -1);

  if (router === "app") {
    if (stem !== "page" && stem !== "route") return null;
    const parts = middle
      .filter((s) => !(s.startsWith("(") && s.endsWith(")"))) // route groups
      .filter((s) => !s.startsWith("@")) // parallel-route slots add no URL segment
      .map(stripInterception)
      .map(normalizeDynamicSegment);
    return {
      router,
      needsContent: stem === "route",
      urlPath: `/${parts.join("/")}`,
      isApi: stem === "route",
    };
  }

  if (stem === "_app" || stem === "_document" || stem === "_error") return null;
  const parts = middle.map(normalizeDynamicSegment);
  if (stem !== "index") parts.push(normalizeDynamicSegment(stem));
  return {
    router,
    needsContent: false,
    urlPath: `/${parts.join("/")}`,
    isApi: middle[0] === "api" || stem === "api",
  };
}

/** "(.)photo" / "(..)photo" / "(...)photo" — interception markers are not URL segments. */
function stripInterception(segment: string): string {
  return segment.replace(/^(\(\.{1,3}\))+/, "");
}

function normalizeDynamicSegment(segment: string): string {
  if (segment.startsWith("[...") || segment.startsWith("[[...")) return "*";
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `{${segment.slice(1, -1)}}`;
  }
  return segment;
}

export function nextJsRoutesFor(
  relPath: string,
  candidate: NextJsCandidate,
  content: string | null,
): UnassignedRoute[] {
  let methods: HttpMethod[];
  if (candidate.needsContent && content !== null) {
    const found = new Set<HttpMethod>();
    let m: RegExpExecArray | null;
    HANDLER_EXPORT_RE.lastIndex = 0;
    while ((m = HANDLER_EXPORT_RE.exec(content)) !== null) {
      found.add(m[1] as HttpMethod);
    }
    methods = found.size > 0 ? [...found].sort() : ["ANY"];
  } else if (candidate.isApi) {
    methods = ["ANY"];
  } else {
    methods = ["GET"];
  }

  return methods.map((method) => ({
    method,
    path: normalizePath(candidate.urlPath),
    rawPath: candidate.urlPath,
    kind: candidate.isApi ? ("api" as const) : ("page" as const),
    framework: "nextjs" as const,
    filePath: relPath,
    line: 1,
    handler: null,
    notes: [],
  }));
}
