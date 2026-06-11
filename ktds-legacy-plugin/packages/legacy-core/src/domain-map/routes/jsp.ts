import { normalizePath } from "../route-key.js";
import type { RouteEntry } from "../types.js";

// S2 JSP direct endpoints — every JSP under a webapp root is URL-addressable
// unless it sits in WEB-INF/META-INF. speclinker never scanned JSP (gap);
// the full census must, because legacy users hit *.jsp URLs directly.

type UnassignedRoute = Omit<RouteEntry, "routeId">;

/** Ordered most-specific-first; first match wins. */
const WEBAPP_MARKERS = ["src/main/webapp/", "WebContent/", "webapp/", "web/"];

export function extractJspRoute(relPath: string): UnassignedRoute | null {
  let webRelative: string | null = null;
  for (const marker of WEBAPP_MARKERS) {
    const idx = indexOfSegmentPrefix(relPath, marker);
    if (idx !== -1) {
      webRelative = relPath.slice(idx + marker.length);
      break;
    }
  }

  // WEB-INF/META-INF JSPs are only reachable via forward — not endpoints.
  if (webRelative !== null && /^(WEB-INF|META-INF)\//i.test(webRelative)) {
    return null;
  }

  const notes: string[] = [];
  let urlPath: string;
  if (webRelative !== null) {
    urlPath = `/${webRelative}`;
  } else {
    // No recognizable webapp root: report rather than silently drop.
    urlPath = `/${relPath}`;
    notes.push("no-webapp-root");
  }

  return {
    method: "GET",
    path: normalizePath(urlPath),
    rawPath: urlPath,
    kind: "page",
    framework: "jsp",
    filePath: relPath,
    line: 1,
    handler: null,
    notes,
  };
}

/** Find `marker` starting at a path-segment boundary; returns its start index. */
function indexOfSegmentPrefix(relPath: string, marker: string): number {
  if (relPath.startsWith(marker)) return 0;
  const idx = relPath.indexOf(`/${marker}`);
  return idx === -1 ? -1 : idx + 1;
}
