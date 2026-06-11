import type { JavaFileFacts, JavaImport } from "./java-facts.js";
import type { EdgeKind, FileEdge, UnresolvedRef } from "./types.js";

// S3 call-chain edge collection + resolution layers (Stage-15, tasks 15.1/15.2).
// Consumes the Stage-14 single-parse facts — no re-parsing here (M4 budget).
// Every reference is exactly one of: resolved (edge), external (out of scope,
// e.g. JDK/library types), or REPORTED in `unresolved` — never silently
// dropped (ADR 미해소 큐 원칙). Determinism: inputs iterated in sorted key
// order, outputs deduped and sorted by natural key.

export interface ClassIndexEntry {
  relPath: string;
  packageName: string | null;
  className: string;
  /** "pkg.Name", "pkg.Outer.Inner" for nested, bare chain in the default package. */
  fqn: string;
  /** True for nested types — same-package simple-name resolution prefers top-level (javac semantics). */
  nested: boolean;
  kind: "class" | "interface" | "annotation" | "enum";
  isAbstract: boolean;
}

export interface ClassIndex {
  /** Simple name → candidates, in sorted-relPath order (deterministic). */
  bySimpleName: Map<string, ClassIndexEntry[]>;
  byFqn: Map<string, ClassIndexEntry>;
  /** Every package that declares at least one project type. */
  packages: Set<string>;
}

export function buildClassIndex(javaFacts: Map<string, JavaFileFacts>): ClassIndex {
  const index: ClassIndex = {
    bySimpleName: new Map(),
    byFqn: new Map(),
    packages: new Set(),
  };
  for (const relPath of [...javaFacts.keys()].sort()) {
    const facts = javaFacts.get(relPath)!;
    if (facts.packageName) index.packages.add(facts.packageName);
    for (const cls of facts.classes) {
      const entry: ClassIndexEntry = {
        relPath,
        packageName: facts.packageName,
        className: cls.name,
        fqn: facts.packageName
          ? `${facts.packageName}.${cls.qualifiedName}`
          : cls.qualifiedName,
        nested: cls.qualifiedName !== cls.name,
        kind: cls.kind,
        isAbstract: cls.isAbstract,
      };
      const list = index.bySimpleName.get(cls.name);
      if (list) list.push(entry);
      else index.bySimpleName.set(cls.name, [entry]);
      // First declaration wins on FQN collision (duplicate FQNs are already
      // a build error in Java; keep the lexicographically first file).
      if (!index.byFqn.has(entry.fqn)) index.byFqn.set(entry.fqn, entry);
    }
  }
  return index;
}

/**
 * MyBatis namespace → mapper-XML relPath. Matches `<mapper namespace="...">`
 * (MyBatis 3) and `<sqlMap namespace="...">` (iBATIS). XML comments are
 * stripped first so commented-out mappers can't claim a namespace.
 */
export function buildMapperNamespaceIndex(
  xmlContents: Map<string, string>,
): Map<string, string> {
  const index = new Map<string, string>();
  const tagRe = /<(?:mapper|sqlMap)\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/g;
  for (const relPath of [...xmlContents.keys()].sort()) {
    const content = xmlContents.get(relPath)!.replace(/<!--[\s\S]*?-->/g, "");
    for (const m of content.matchAll(tagRe)) {
      // First file (sorted order) wins a namespace collision.
      if (!index.has(m[1])) index.set(m[1], relPath);
    }
  }
  return index;
}

// ── Type-reference resolution (15.2 layers ①③④ + import) ──────────────────

type Resolution =
  | { kind: "resolved"; relPath: string }
  | { kind: "external" }
  | { kind: "ambiguous" }
  | { kind: "not-found" };

function lastSegment(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? path : path.slice(idx + 1);
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** True when the dotted path lives under a package that declares project types. */
function inProjectPackage(index: ClassIndex, dottedPath: string): boolean {
  const pkg = parentPath(dottedPath);
  if (!pkg) return false;
  if (index.packages.has(pkg)) return true;
  for (const p of index.packages) {
    if (pkg.startsWith(p + ".")) return true;
  }
  return false;
}

/**
 * Resolve a type reference as javac would, restricted to project types:
 * explicit import > same package > wildcard import > unique project-wide
 * candidate. Types absent from the project index are external (JDK/libs) —
 * out of scope by design, not failures.
 */
export function resolveTypeRef(
  typeName: string,
  facts: JavaFileFacts,
  index: ClassIndex,
): Resolution {
  let name = typeName.trim();
  while (name.endsWith("[]")) name = name.slice(0, -2).trim();
  if (!name) return { kind: "external" };

  if (name.includes(".")) {
    const exact = index.byFqn.get(name);
    if (exact) return { kind: "resolved", relPath: exact.relPath };
    // "Outer.Inner" written with the outer simple name: resolve the head.
    const head = name.slice(0, name.indexOf("."));
    if (/^[A-Z]/.test(head) && index.bySimpleName.has(head)) {
      return resolveTypeRef(head, facts, index);
    }
    if (inProjectPackage(index, name)) return { kind: "not-found" };
    return { kind: "external" };
  }

  const candidates = index.bySimpleName.get(name) ?? [];

  const explicit = facts.imports.find(
    (i) => !i.wildcard && !i.isStatic && lastSegment(i.path) === name,
  );
  if (explicit) {
    const entry = index.byFqn.get(explicit.path);
    if (entry) return { kind: "resolved", relPath: entry.relPath };
    if (inProjectPackage(index, explicit.path)) return { kind: "not-found" };
    return { kind: "external" };
  }

  const samePkg = candidates.filter((c) => c.packageName === facts.packageName);
  if (samePkg.length === 1) return { kind: "resolved", relPath: samePkg[0].relPath };
  if (samePkg.length > 1) {
    // A bare name from another file resolves to the TOP-LEVEL type; nested
    // namesakes need "Outer.Inner" qualification (javac semantics).
    const topLevel = samePkg.filter((c) => !c.nested);
    if (topLevel.length === 1) return { kind: "resolved", relPath: topLevel[0].relPath };
    return { kind: "ambiguous" };
  }

  const wildcardPkgs = new Set(
    facts.imports.filter((i) => i.wildcard && !i.isStatic).map((i) => i.path),
  );
  const viaWildcard = candidates.filter(
    (c) => c.packageName !== null && wildcardPkgs.has(c.packageName),
  );
  if (viaWildcard.length === 1) {
    return { kind: "resolved", relPath: viaWildcard[0].relPath };
  }
  if (viaWildcard.length > 1) return { kind: "ambiguous" };

  if (candidates.length === 1) return { kind: "resolved", relPath: candidates[0].relPath };
  if (candidates.length > 1) return { kind: "ambiguous" };
  // Zero candidates for a bare name: indistinguishable from a JDK/library
  // type at file granularity, so this is an INTENTIONAL non-report — a truly
  // missing project type written unqualified lands here too (the 15.4 recall
  // harness is the instrument that tracks that residue, ADR §3).
  return { kind: "external" };
}

// ── Edge collection (15.1) ─────────────────────────────────────────────────

/** Qualified string literal "Ns.Sub.id" — the MyBatis SqlSession call shape. */
const QUALIFIED_STRING_RE = /"([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)"/g;

export function collectEdges(
  javaFacts: Map<string, JavaFileFacts>,
  classIndex: ClassIndex,
  mapperNamespaces: Map<string, string>,
): { edges: FileEdge[]; unresolved: UnresolvedRef[] } {
  const edges: FileEdge[] = [];
  const unresolved: UnresolvedRef[] = [];

  const addEdge = (
    source: string,
    target: string,
    kind: EdgeKind,
    line: number | null,
  ): void => {
    if (source !== target) edges.push({ source, target, kind, line });
  };
  const addUnresolved = (
    source: string,
    ref: string,
    reason: UnresolvedRef["reason"],
  ): void => {
    unresolved.push({ source, ref, reason });
  };

  const resolveAndEdge = (
    source: string,
    facts: JavaFileFacts,
    typeName: string,
    kind: EdgeKind,
    line: number | null,
  ): string | null => {
    const res = resolveTypeRef(typeName, facts, classIndex);
    if (res.kind === "resolved") {
      addEdge(source, res.relPath, kind, line);
      return res.relPath;
    }
    if (res.kind === "ambiguous") addUnresolved(source, typeName, "ambiguous");
    else if (res.kind === "not-found") addUnresolved(source, typeName, "not-found");
    return null;
  };

  for (const relPath of [...javaFacts.keys()].sort()) {
    const facts = javaFacts.get(relPath)!;

    for (const imp of facts.imports) {
      collectImportEdge(relPath, imp, classIndex, addEdge, addUnresolved);
    }

    for (const cls of facts.classes) {
      if (cls.superclass) {
        resolveAndEdge(
          relPath,
          facts,
          cls.superclass,
          "extends",
          cls.superclassLine ?? cls.line,
        );
      }
      for (const iface of cls.interfaces) {
        const ifaceFile = resolveAndEdge(
          relPath,
          facts,
          iface.name,
          "implements",
          iface.line,
        );
        // Reverse link so reachability can cross interface-typed references
        // into the implementation (15.2 ① — explicit-implements case).
        if (ifaceFile) addEdge(ifaceFile, relPath, "impl", null);
      }
      for (const field of cls.fields) {
        const kind = field.injected ? "injection" : "field-type";
        resolveAndEdge(relPath, facts, field.typeName, kind, field.line);
        // List<Order> orders: the element type is the actual collaborator.
        for (const arg of field.typeArgNames) {
          resolveAndEdge(relPath, facts, arg, kind, field.line);
        }
      }
      for (const param of cls.ctorParamTypes) {
        resolveAndEdge(relPath, facts, param.typeName, "ctor-param", param.line);
      }

      // 15.2 ②⑤: typed mapper interface whose FQN is a mapper-XML namespace
      // (the mybatis-spring wildcard-scan pattern needs no further signal —
      // FQN==namespace is the binding contract).
      if (cls.kind === "interface") {
        const fqn = facts.packageName
          ? `${facts.packageName}.${cls.qualifiedName}`
          : cls.qualifiedName;
        const xml = mapperNamespaces.get(fqn);
        if (xml) addEdge(relPath, xml, "mapper-xml", cls.line);
      }

      // 15.2 ②: SqlSession string calls — "namespace.statementId" literals.
      // Deliberately recall-first: ANY dotted literal whose parent path is a
      // registered namespace counts, so a constant like "ns.Mapper.CACHE_KEY"
      // would over-include that XML in a slice. Acceptable: a false edge only
      // widens a slice (shared-isolation absorbs it); a missed edge severs a
      // chain. Tighten to call-site tokens only if precision data demands it.
      for (const method of cls.methods) {
        if (!method.bodyText || method.bodyLine === null) continue;
        for (const m of method.bodyText.matchAll(QUALIFIED_STRING_RE)) {
          const xml = mapperNamespaces.get(parentPath(m[1]));
          if (!xml) continue;
          const offset = m.index ?? 0;
          const line =
            method.bodyLine + countNewlines(method.bodyText.slice(0, offset));
          addEdge(relPath, xml, "mybatis", line);
        }
      }
    }
  }

  collectNameConventionImplEdges(classIndex, addEdge, addUnresolved);

  return {
    edges: dedupeSortEdges(edges),
    unresolved: dedupeSortUnresolved(unresolved),
  };
}

function collectImportEdge(
  source: string,
  imp: JavaImport,
  index: ClassIndex,
  addEdge: (s: string, t: string, k: EdgeKind, l: number | null) => void,
  addUnresolved: (s: string, r: string, reason: UnresolvedRef["reason"]) => void,
): void {
  // Package wildcard (import com.foo.*) has no single target — it only feeds
  // type resolution. Static wildcard/member imports point at the host class.
  let fqn: string;
  if (imp.wildcard) {
    if (!imp.isStatic) return;
    fqn = imp.path;
  } else {
    fqn = imp.isStatic ? parentPath(imp.path) : imp.path;
  }
  const entry = index.byFqn.get(fqn);
  if (entry) {
    if (entry.relPath !== source) addEdge(source, entry.relPath, "import", imp.line);
    return;
  }
  // Project-package-shaped but missing from the census: report, don't drop —
  // generated/excluded sources show up here.
  if (inProjectPackage(index, fqn)) addUnresolved(source, imp.path, "not-found");
}

/**
 * 15.2 ①: name-convention implementor — interface X + class XImpl with no
 * explicit `implements` link still gets an interface→impl edge (Spring XML
 * wiring / proxy patterns). Same-package implementors are preferred.
 */
function collectNameConventionImplEdges(
  index: ClassIndex,
  addEdge: (s: string, t: string, k: EdgeKind, l: number | null) => void,
  addUnresolved: (s: string, r: string, reason: UnresolvedRef["reason"]) => void,
): void {
  for (const [name, entries] of [...index.bySimpleName.entries()].sort(([a], [b]) =>
    cmp(a, b),
  )) {
    for (const iface of entries) {
      if (iface.kind !== "interface") continue;
      const impls = (index.bySimpleName.get(`${name}Impl`) ?? []).filter(
        (c) => c.kind === "class",
      );
      if (impls.length === 0) continue;
      const samePkg = impls.filter((c) => c.packageName === iface.packageName);
      const chosen = samePkg.length > 0 ? samePkg : impls;
      if (chosen.length === 1) {
        addEdge(iface.relPath, chosen[0].relPath, "impl", null);
      } else {
        addUnresolved(iface.relPath, `${name}Impl`, "ambiguous");
      }
    }
  }
}

// ── Determinism boundary ───────────────────────────────────────────────────

function dedupeSortEdges(edges: FileEdge[]): FileEdge[] {
  // One edge per (source, target, kind); keep the smallest concrete evidence
  // line (null = no line evidence, loses to any concrete line).
  const byKey = new Map<string, FileEdge>();
  for (const e of edges) {
    const key = `${e.source} ${e.target} ${e.kind}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
    } else if (e.line !== null && (prev.line === null || e.line < prev.line)) {
      byKey.set(key, e);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.kind, b.kind),
  );
}

function dedupeSortUnresolved(refs: UnresolvedRef[]): UnresolvedRef[] {
  const byKey = new Map<string, UnresolvedRef>();
  for (const r of refs) {
    byKey.set(`${r.source} ${r.ref} ${r.reason}`, r);
  }
  return [...byKey.values()].sort(
    (a, b) => cmp(a.source, b.source) || cmp(a.ref, b.ref) || cmp(a.reason, b.reason),
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}
