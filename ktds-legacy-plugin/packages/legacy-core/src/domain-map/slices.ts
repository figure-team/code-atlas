import type {
  CensusReport,
  EdgesReport,
  FileOwnership,
  RoutesReport,
  Slice,
  SlicesReport,
} from "./types.js";

// S4 reachability slicer (Stage-15, task 15.3). Roots are the files that
// declare routes/batch entries (S2 output); reach is BFS over S3 edges with a
// depth cap. Classification: sole reach = domain candidate, multi reach =
// common-isolation candidate, unreached = 미해소 큐 — reported, never dropped
// (Stage-16 filename fallback's input). Determinism: sorted roots, sorted
// adjacency, sorted output arrays; BFS visit order cannot leak into the
// artifact because `reached` is a set re-sorted at the end.

/**
 * Controller→service→mapper→XML is 4-5 hops; 12 absorbs deep template-method
 * towers without letting one giant hub swallow the whole graph.
 */
export const DEFAULT_DEPTH_CAP = 12;

export function buildSlices(
  census: CensusReport,
  routes: RoutesReport,
  edgesReport: EdgesReport,
  depthCap: number = DEFAULT_DEPTH_CAP,
): SlicesReport {
  // Root file → natural keys of the entries it declares.
  const entryIdsByRoot = new Map<string, string[]>();
  const addEntry = (filePath: string, id: string): void => {
    const list = entryIdsByRoot.get(filePath);
    if (list) list.push(id);
    else entryIdsByRoot.set(filePath, [id]);
  };
  for (const route of routes.routes) addEntry(route.filePath, route.routeId);
  for (const batch of routes.batchEntries) addEntry(batch.filePath, batch.entryId);

  const adjacency = new Map<string, string[]>();
  for (const edge of edgesReport.edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);
  }
  for (const [source, targets] of adjacency) {
    adjacency.set(source, [...new Set(targets)].sort());
  }

  const roots = [...entryIdsByRoot.keys()].sort();
  const slices: Slice[] = roots.map((root) => ({
    root,
    entryIds: [...entryIdsByRoot.get(root)!].sort(),
    reached: bfs(root, adjacency, depthCap),
  }));

  // Ownership over the full census — files outside every slice are exactly
  // the unresolved queue.
  const ownersByFile = new Map<string, string[]>();
  for (const slice of slices) {
    for (const file of slice.reached) {
      const list = ownersByFile.get(file);
      if (list) list.push(slice.root);
      else ownersByFile.set(file, [slice.root]);
    }
  }
  const ownership: FileOwnership[] = census.files.map((file) => {
    const owners = ownersByFile.get(file.relPath) ?? [];
    return {
      relPath: file.relPath,
      status: owners.length === 0 ? "unreached" : owners.length === 1 ? "sole" : "shared",
      owners: [...owners].sort(),
    };
  });

  return {
    schemaVersion: 1,
    gitCommit: census.gitCommit,
    depthCap,
    slices,
    ownership,
  };
}

/** Files reachable from root within depthCap hops, root included, sorted. */
function bfs(
  root: string,
  adjacency: Map<string, string[]>,
  depthCap: number,
): string[] {
  const visited = new Set<string>([root]);
  let frontier = [root];
  for (let depth = 0; depth < depthCap && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of adjacency.get(file) ?? []) {
        if (!visited.has(target)) {
          visited.add(target);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return [...visited].sort();
}
