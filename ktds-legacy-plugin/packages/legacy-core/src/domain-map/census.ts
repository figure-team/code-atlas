import ignore, { type Ignore } from "ignore";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SOURCE_LANG_BY_EXT,
  type CensusFile,
  type CensusReport,
  type KgCrossCheck,
} from "./types.js";
import { gitCommitHash } from "./persist.js";

const execFileAsync = promisify(execFile);

// S1 — full census: git ls-files ∩ source-extension filter, NO sampling
// (ADR §1.2 rejects U-A's 200-entry/40-file/512KB caps). The census is the
// denominator every later stage divides by, so silent omission here poisons
// recall measurements downstream (task plan D8).

/**
 * Data snapshot of U-A's DEFAULT_IGNORE_PATTERNS (14.2 "U-A ignore 정합").
 * Provenance: understand-anything-plugin/packages/core/src/ignore-filter.ts —
 * copied as DATA, never imported as code (ADR D5 / A17-style snapshot). The
 * same patterns the U-A scanner used to build the KG must drive the census,
 * or the KG cross-check misclassifies U-A's own exclusions as "KG stale".
 */
export const UA_DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "node_modules/",
  ".git/",
  "vendor/",
  "venv/",
  ".venv/",
  "__pycache__/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".cache/",
  ".turbo/",
  "target/",
  "obj/",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.svg",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp3",
  "*.mp4",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.generated.*",
  ".idea/",
  ".vscode/",
  "LICENSE",
  ".gitignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc*",
  "*.log",
];

/**
 * ktds additions on top of the U-A defaults:
 * - tool-state dirs (.spec/.understand-anything/.omc) — a tool must never
 *   census its own artifacts, regardless of the target repo's .gitignore
 *   (legacy repos won't ignore OUR state dirs; review finding: git mode
 *   otherwise diverges from walk mode and feeds outputs back as inputs)
 * - other VCS internals (.svn/.hg — SVN-era legacy repos)
 * - vendored build-bootstrap code (.mvn wrapper, gradle wrapper) — jpetstore
 *   smoke run surfaced MavenWrapperDownloader.main as a phantom batch entry
 */
const KTDS_IGNORE_PATTERNS: readonly string[] = [
  ".spec/",
  ".understand-anything/",
  ".omc/",
  ".svn/",
  ".hg/",
  ".mvn/",
  "**/gradle/wrapper/",
];

export interface CensusIgnoreFilter {
  /** gitignore semantics (negation, anchoring) via the same `ignore` package U-A uses. */
  isIgnored(relPath: string): boolean;
  /** Directory probe for walk pruning ("dir/" form). */
  isIgnoredDir(relDir: string): boolean;
}

/**
 * Census ignore filter — mirrors U-A createIgnoreFilter's layer order so
 * census exclusions and the KG scanner's exclusions agree:
 * 1. U-A defaults (snapshot) + ktds tool-state patterns
 * 2. .understand-anything/.understandignore
 * 3. .understandignore at project root (later layers may negate earlier ones)
 */
export async function createCensusIgnoreFilter(
  projectRoot: string,
): Promise<CensusIgnoreFilter> {
  const ig: Ignore = ignore();
  ig.add([...UA_DEFAULT_IGNORE_PATTERNS]);
  ig.add([...KTDS_IGNORE_PATTERNS]);
  for (const layer of [
    path.join(projectRoot, ".understand-anything", ".understandignore"),
    path.join(projectRoot, ".understandignore"),
  ]) {
    try {
      ig.add(await fs.readFile(layer, "utf-8"));
    } catch {
      // layer absent — fine
    }
  }
  return {
    isIgnored: (relPath) => ig.ignores(relPath),
    isIgnoredDir: (relDir) => ig.ignores(relDir.endsWith("/") ? relDir : `${relDir}/`),
  };
}

/**
 * Test-source exclusion (14.2 DoD: "테스트 제외 정확"). Deliberately narrow —
 * over-exclusion violates the full-census principle:
 * - Maven/Gradle standard test root: src/test/
 * - repo-root test/ or tests/
 * - JS/TS test idioms: __tests__/, *.test.*, *.spec.*
 * - Java suffix conventions: *Test.java, *Tests.java, *TestCase.java
 */
export function isTestPath(relPath: string): boolean {
  return (
    /(^|\/)src\/test\//.test(relPath) ||
    /^tests?\//.test(relPath) ||
    /(^|\/)__tests__\//.test(relPath) ||
    /\.test\.[^/.]+$/.test(relPath) ||
    /\.spec\.[^/.]+$/.test(relPath) ||
    /(Test|Tests|TestCase)\.java$/.test(relPath)
  );
}

export function langForPath(relPath: string): string | null {
  const ext = path.posix.extname(relPath).toLowerCase();
  return SOURCE_LANG_BY_EXT[ext] ?? null;
}

// ── File listing ───────────────────────────────────────────────────────────

/**
 * List candidate files. Git mode includes untracked-but-not-ignored files
 * (--others --exclude-standard) so a dirty worktree is still a full census.
 * The walk fallback exists for the plan's VCS matrix (Git/SVN/none — MVP plan
 * 단계4 VCS 감지); it engages ONLY when git is absent or the root is not a
 * work tree. Any other git failure (e.g. maxBuffer) must surface, not
 * silently change census semantics (review finding).
 */
async function listFiles(projectRoot: string, filter: CensusIgnoreFilter): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: projectRoot, maxBuffer: 256 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((p) => p.length > 0);
  } catch (err: unknown) {
    if (isGitUnavailable(err)) return walkDir(projectRoot, "", filter);
    throw err;
  }
}

function isGitUnavailable(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true; // no git binary
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && /not a git repository/i.test(stderr)) return true;
  }
  return false;
}

async function walkDir(
  root: string,
  rel: string,
  filter: CensusIgnoreFilter,
): Promise<string[]> {
  const abs = rel === "" ? root : path.join(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      // Prune with the same filter that governs file inclusion — walk mode
      // must never see more (or fewer) directories than git mode filters out.
      if (filter.isIgnoredDir(childRel)) continue;
      out.push(...(await walkDir(root, childRel, filter)));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

// ── KG cross-check ─────────────────────────────────────────────────────────

interface ExclusionVerdict {
  excluded: boolean;
  /** True when one of our filters explains the exclusion (tier 1: "ignored"). */
  explained: boolean;
}

function classifyKgPath(
  relPath: string,
  filter: CensusIgnoreFilter,
  censusSet: Set<string>,
): ExclusionVerdict {
  if (censusSet.has(relPath)) return { excluded: false, explained: true };
  const explained =
    langForPath(relPath) === null ||
    isTestPath(relPath) ||
    filter.isIgnored(relPath);
  return { excluded: true, explained };
}

async function readKgFilePaths(projectRoot: string): Promise<string[] | null> {
  const kgPath = path.join(projectRoot, ".understand-anything", "knowledge-graph.json");
  let raw: string;
  try {
    raw = await fs.readFile(kgPath, "utf-8");
  } catch {
    return null;
  }
  // Lenient on purpose: the KG is advisory input here; a malformed KG must not
  // block the census (the orchestrator's kg-reader owns strict validation).
  try {
    const parsed = JSON.parse(raw) as {
      nodes?: Array<{ type?: string; filePath?: string }>;
    };
    if (!Array.isArray(parsed.nodes)) return null;
    const paths = new Set<string>();
    for (const node of parsed.nodes) {
      if (node.type === "file" && typeof node.filePath === "string") {
        paths.add(normalizeRel(node.filePath));
      }
    }
    return [...paths].sort();
  } catch {
    return null;
  }
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
}

// ── Census builder ─────────────────────────────────────────────────────────

export async function buildCensus(projectRoot: string): Promise<CensusReport> {
  const filter = await createCensusIgnoreFilter(projectRoot);

  const candidates = await listFiles(projectRoot, filter);
  const files: CensusFile[] = [];
  for (const raw of candidates) {
    const relPath = normalizeRel(raw);
    const lang = langForPath(relPath);
    if (lang === null) continue;
    if (isTestPath(relPath)) continue;
    if (filter.isIgnored(relPath)) continue;
    // Tracked-but-deleted files appear in git ls-files; drop them so route
    // extraction never reads a path that no longer exists.
    try {
      await fs.access(path.join(projectRoot, relPath));
    } catch {
      continue;
    }
    files.push({ relPath, lang });
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const kgPaths = await readKgFilePaths(projectRoot);
  let kgCrossCheck: KgCrossCheck | null = null;
  if (kgPaths !== null) {
    const censusSet = new Set(files.map((f) => f.relPath));
    const kgOnlyIgnored: string[] = [];
    const kgOnlyMissing: string[] = [];
    for (const kgPath of kgPaths) {
      const verdict = classifyKgPath(kgPath, filter, censusSet);
      if (!verdict.excluded) continue;
      if (verdict.explained) kgOnlyIgnored.push(kgPath);
      else kgOnlyMissing.push(kgPath);
    }
    const kgSet = new Set(kgPaths);
    const censusOnly = files.map((f) => f.relPath).filter((p) => !kgSet.has(p));
    kgCrossCheck = { kgOnlyIgnored, kgOnlyMissing, censusOnly };
  }

  return {
    schemaVersion: 1,
    gitCommit: await gitCommitHash(projectRoot),
    fileCount: files.length,
    files,
    kgCrossCheck,
  };
}
