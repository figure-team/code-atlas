import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CENSUS_FILENAME,
  EDGES_FILENAME,
  ROUTES_FILENAME,
  SLICES_FILENAME,
  SPEC_MAP_DIR,
  type CensusReport,
  type EdgesReport,
  type RoutesReport,
  type SlicesReport,
} from "./types.js";

const execFileAsync = promisify(execFile);

// .spec/map/ persistence (ADR D6). Serialization is the determinism boundary:
// JSON.stringify preserves construction order, and every producer constructs
// objects in schema order with pre-sorted arrays, so same input → same bytes.

export function specMapDir(projectRoot: string): string {
  return path.join(projectRoot, ".spec", SPEC_MAP_DIR);
}

/** Stable JSON serialization: 2-space indent + trailing newline. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export async function writeMapArtifact(
  projectRoot: string,
  filename: string,
  value: unknown,
): Promise<string> {
  const dir = specMapDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, stableJson(value), "utf-8");
  return filePath;
}

export async function writeCensus(
  projectRoot: string,
  census: CensusReport,
): Promise<string> {
  return writeMapArtifact(projectRoot, CENSUS_FILENAME, census);
}

export async function writeRoutes(
  projectRoot: string,
  routes: RoutesReport,
): Promise<string> {
  return writeMapArtifact(projectRoot, ROUTES_FILENAME, routes);
}

export async function writeEdges(
  projectRoot: string,
  edges: EdgesReport,
): Promise<string> {
  return writeMapArtifact(projectRoot, EDGES_FILENAME, edges);
}

export async function writeSlices(
  projectRoot: string,
  slices: SlicesReport,
): Promise<string> {
  return writeMapArtifact(projectRoot, SLICES_FILENAME, slices);
}

/** HEAD commit hash, or null outside a git work tree (SVN/no-VCS projects). */
export async function gitCommitHash(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
    });
    const hash = stdout.trim();
    return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}
