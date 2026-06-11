import type {
  JavaAnnotation,
  JavaClassFacts,
  JavaFileFacts,
} from "../java-facts.js";
import { normalizePath } from "../route-key.js";
import type { HttpMethod, RouteEntry } from "../types.js";

// S2 Spring route extraction (task 14.3). Improvements over the speclinker
// baseline it ports (ADR D7 — 원작자 허락): composed meta-annotations, constant
// resolution, ALL paths of multi-value mappings, ALL verbs of multi-method
// mappings, nested classes. No caps, no sampling.

type UnassignedRoute = Omit<RouteEntry, "routeId">;

const MAPPING_VERBS: Record<string, HttpMethod> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};

/** jwork + Spring generic JSON-response signals (speclinker API_BODY_SIGNALS). */
const API_BODY_SIGNALS =
  /GridResultUtil|AjaxMessageMapRenderer|ResponseEntity|MAPPING_JACKSON_JSON_VIEW|JSON_VIEW|jsonView|MappingJackson|new\s+ModelAndView\s*\(\s*[A-Za-z0-9_.]*[Jj]son/;

// ── Global indexes (built once over all scanned files) ─────────────────────

export interface ComposedMapping {
  /** Verbs fixed by the meta-annotation (e.g. @GetMapping meta → GET). */
  verbs: HttpMethod[];
  /** Default paths declared on the meta-annotation. */
  paths: string[];
}

export interface SpringIndexes {
  /** "@interface X" meta-annotated with a mapping annotation → its defaults. */
  composedMappings: Map<string, ComposedMapping>;
  /** "@interface X" meta-annotated with @Controller/@RestController. */
  composedStereotypes: Map<string, { isRest: boolean }>;
  /** "ClassName.CONST" → literal value, across the whole census. */
  constants: Map<string, string>;
}

export function buildSpringIndexes(
  factsByPath: Map<string, JavaFileFacts>,
): SpringIndexes {
  const indexes: SpringIndexes = {
    composedMappings: new Map(),
    composedStereotypes: new Map(),
    constants: new Map(),
  };
  // Iteration follows the census's sorted path order, so on duplicate class
  // names the lexicographically-first declaration wins deterministically.
  for (const facts of factsByPath.values()) {
    for (const [key, value] of facts.constants) {
      if (key.includes(".") && !indexes.constants.has(key)) {
        indexes.constants.set(key, value);
      }
    }
    for (const cls of facts.classes) {
      if (cls.kind !== "annotation") continue;
      const stereo = stereotypeOf(cls.annotations);
      if (stereo && !indexes.composedStereotypes.has(cls.name)) {
        indexes.composedStereotypes.set(cls.name, stereo);
      }
      const mapping = metaMappingOf(cls.annotations, facts, indexes.constants);
      if (mapping && !indexes.composedMappings.has(cls.name)) {
        indexes.composedMappings.set(cls.name, mapping);
      }
    }
  }
  return indexes;
}

function stereotypeOf(
  annotations: JavaAnnotation[],
): { isRest: boolean } | null {
  let found = false;
  let isRest = false;
  for (const ann of annotations) {
    if (ann.name === "RestController") {
      found = true;
      isRest = true;
    } else if (ann.name === "Controller") {
      found = true;
    }
  }
  return found ? { isRest } : null;
}

function metaMappingOf(
  annotations: JavaAnnotation[],
  facts: JavaFileFacts,
  globalConstants: Map<string, string>,
): ComposedMapping | null {
  for (const ann of annotations) {
    const fixedVerb = MAPPING_VERBS[ann.name];
    if (fixedVerb) {
      const { paths } = resolvePaths(ann, facts, globalConstants);
      return { verbs: [fixedVerb], paths };
    }
    if (ann.name === "RequestMapping") {
      const { paths } = resolvePaths(ann, facts, globalConstants);
      return { verbs: verbsFromRequestMapping(ann), paths };
    }
  }
  return null;
}

// ── Per-class extraction ───────────────────────────────────────────────────

export function extractSpringRoutes(
  relPath: string,
  facts: JavaFileFacts,
  indexes: SpringIndexes,
): UnassignedRoute[] {
  const routes: UnassignedRoute[] = [];
  for (const cls of facts.classes) {
    if (cls.kind !== "class") continue;
    routes.push(...extractClassRoutes(relPath, cls, facts, indexes));
  }
  return routes;
}

function extractClassRoutes(
  relPath: string,
  cls: JavaClassFacts,
  facts: JavaFileFacts,
  indexes: SpringIndexes,
): UnassignedRoute[] {
  const stereo = classStereotype(cls, indexes);
  if (!stereo.isController) return [];

  const classNotes: string[] = [...stereo.notes];
  const isAllApi =
    stereo.isRest || cls.annotations.some((a) => a.name === "ResponseBody");

  // Class-level base paths: @RequestMapping or a composed mapping annotation.
  let basePaths = [""];
  const classMapping = findMapping(cls.annotations, indexes);
  if (classMapping) {
    const resolved = resolvePaths(classMapping.annotation, facts, indexes.constants);
    classNotes.push(...resolved.notes);
    if (classMapping.composed && resolved.paths.length === 0) {
      resolved.paths.push(...classMapping.composed.paths);
    }
    if (resolved.paths.length > 0) {
      // Trailing "/*" on a class mapping is a DispatcherServlet wildcard, not
      // a URL segment (speclinker H rule).
      basePaths = resolved.paths.map((p) => p.replace(/\/\*$/, ""));
    }
  }

  const routes: UnassignedRoute[] = [];
  for (const method of cls.methods) {
    const mapping = findMapping(method.annotations, indexes);
    if (!mapping) continue;

    const notes = [...classNotes];
    if (mapping.composedName) notes.push(`composed:@${mapping.composedName}`);

    const resolved = resolvePaths(mapping.annotation, facts, indexes.constants);
    notes.push(...resolved.notes);
    let methodPaths = resolved.paths;
    if (methodPaths.length === 0 && mapping.composed) {
      methodPaths = [...mapping.composed.paths];
    }
    if (methodPaths.length === 0) methodPaths = [""];

    const verbs = methodVerbs(mapping);

    const isApi =
      isAllApi ||
      method.annotations.some((a) => a.name === "ResponseBody") ||
      /^(ResponseEntity|HttpEntity)\b/.test(method.returnType ?? "") ||
      API_BODY_SIGNALS.test(method.bodyText);

    for (const base of basePaths) {
      for (const sub of methodPaths) {
        const rawPath = joinPaths(base, sub);
        for (const verb of verbs) {
          routes.push({
            method: verb,
            path: normalizePath(rawPath),
            rawPath,
            kind: isApi ? "api" : "form",
            framework: "spring",
            filePath: relPath,
            line: mapping.annotation.line,
            handler: `${cls.name}#${method.name}`,
            notes: [...new Set(notes)].sort(),
          });
        }
      }
    }
  }
  return routes;
}

function classStereotype(
  cls: JavaClassFacts,
  indexes: SpringIndexes,
): { isController: boolean; isRest: boolean; notes: string[] } {
  let isController = false;
  let isRest = false;
  const notes: string[] = [];
  for (const ann of cls.annotations) {
    if (ann.name === "RestController") {
      isController = true;
      isRest = true;
    } else if (ann.name === "Controller") {
      isController = true;
    } else {
      const composed = indexes.composedStereotypes.get(ann.name);
      if (composed) {
        isController = true;
        isRest ||= composed.isRest;
        notes.push(`composed:@${ann.name}`);
      }
    }
  }
  return { isController, isRest, notes };
}

interface FoundMapping {
  annotation: JavaAnnotation;
  /** Set when the mapping came from a composed meta-annotation. */
  composed: ComposedMapping | null;
  composedName: string | null;
}

function findMapping(
  annotations: JavaAnnotation[],
  indexes: SpringIndexes,
): FoundMapping | null {
  for (const ann of annotations) {
    if (MAPPING_VERBS[ann.name] || ann.name === "RequestMapping") {
      return { annotation: ann, composed: null, composedName: null };
    }
  }
  for (const ann of annotations) {
    const composed = indexes.composedMappings.get(ann.name);
    if (composed) return { annotation: ann, composed, composedName: ann.name };
  }
  return null;
}

/** All verbs of a mapping — multi-method @RequestMapping emits one route each. */
function methodVerbs(mapping: FoundMapping): HttpMethod[] {
  const direct = MAPPING_VERBS[mapping.annotation.name];
  if (direct) return [direct];
  // Use-site method= wins over composed defaults.
  const fromArgs = verbsFromRequestMapping(mapping.annotation);
  if (fromArgs.length > 0 && !(fromArgs.length === 1 && fromArgs[0] === "ANY")) {
    return fromArgs;
  }
  if (mapping.composed && mapping.composed.verbs.length > 0) {
    return mapping.composed.verbs;
  }
  return fromArgs.length > 0 ? fromArgs : ["ANY"];
}

function verbsFromRequestMapping(ann: JavaAnnotation): HttpMethod[] {
  const refs = ann.args["method"]?.refs ?? [];
  const verbs: HttpMethod[] = [];
  for (const ref of refs) {
    const match = /(?:^|\.)(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.exec(ref);
    if (match) verbs.push(match[1] as HttpMethod);
  }
  return verbs.length > 0 ? verbs : ["ANY"];
}

// ── Path value resolution ──────────────────────────────────────────────────

interface ResolvedPaths {
  paths: string[];
  notes: string[];
}

/**
 * Resolve a mapping annotation's path values: string literals pass through,
 * constant references resolve file-locally then census-globally. Unresolvable
 * refs become "/__unresolved__/<ref>" — reported, never silently dropped
 * (full-census principle; the S7 human gate surfaces these).
 */
function resolvePaths(
  ann: JavaAnnotation,
  facts: JavaFileFacts,
  globalConstants: Map<string, string>,
): ResolvedPaths {
  const paths: string[] = [];
  const notes: string[] = [];
  for (const key of ["value", "path"] as const) {
    const arg = ann.args[key];
    if (!arg) continue;
    for (const s of arg.strings) {
      if (isPathLike(s)) paths.push(s);
    }
    for (const ref of arg.refs) {
      if (/^RequestMethod\b|\.RequestMethod\./.test(ref)) continue;
      const value = resolveConstant(ref, facts, globalConstants);
      if (value !== null) {
        if (isPathLike(value)) {
          paths.push(value);
          notes.push(`constant:${ref}`);
        }
      } else {
        paths.push(`/__unresolved__/${ref}`);
        notes.push(`unresolved-constant:${ref}`);
      }
    }
  }
  return { paths, notes };
}

function resolveConstant(
  ref: string,
  facts: JavaFileFacts,
  globalConstants: Map<string, string>,
): string | null {
  // Concat expression captured whole by java-facts (CONST + "/suffix"):
  // fold it if every operand resolves; otherwise report unresolved.
  if (ref.includes("+")) return foldConcat(ref, facts, globalConstants);
  const local = facts.constants.get(ref);
  if (local !== undefined) return local;
  // "a.b.Constants.BASE" → "Constants.BASE" for the global ClassName.CONST index.
  const segments = ref.split(".");
  if (segments.length >= 2) {
    const tail = segments.slice(-2).join(".");
    const global = globalConstants.get(tail);
    if (global !== undefined) return global;
  }
  return null;
}

/** Fold `A + "x" + B` — every operand must be a string literal or a resolvable constant. */
function foldConcat(
  expr: string,
  facts: JavaFileFacts,
  globalConstants: Map<string, string>,
): string | null {
  const parts = splitTopLevelPlus(expr);
  if (parts.length < 2) return null;
  let out = "";
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (/^".*"$/s.test(part)) {
      out += part.slice(1, -1);
    } else if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(part)) {
      const resolved = resolveConstant(part, facts, globalConstants);
      if (resolved === null) return null;
      out += resolved;
    } else {
      return null;
    }
  }
  return out;
}

/** Split on '+' outside string literals (annotation constants never nest parens). */
function splitTopLevelPlus(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"' && expr[i - 1] !== "\\") inString = !inString;
    if (ch === "+" && !inString) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * A mapping value is a path when absolute, or a bare relative segment.
 * Filters media types like "application/json" (slash but not absolute) and
 * params/headers attribute strings ("=", ";") — speclinker isAbsPath/isRelSegment.
 */
function isPathLike(value: string): boolean {
  if (value.startsWith("/")) return true;
  return !value.includes("/") && !value.includes("=") && !value.includes(";");
}

function joinPaths(base: string, sub: string): string {
  if (base === "") return sub === "" ? "/" : sub;
  if (sub === "") return base;
  return `${base}/${sub}`.replace(/\/{2,}/g, "/");
}
