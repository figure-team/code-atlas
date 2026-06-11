import type { JavaFileFacts } from "../java-facts.js";
import { normalizePath } from "../route-key.js";
import type { RouteEntry } from "../types.js";

// S2 Stripes route extraction (task 14.4 — jpetstore E2E fixture uses Stripes).
// Two signals: explicit @UrlBinding, and the NameBasedActionResolver
// convention jpetstore-6 actually relies on (no @UrlBinding in that codebase).

type UnassignedRoute = Omit<RouteEntry, "routeId">;

/**
 * NameBasedActionResolver base packages — URL = segments AFTER the last one.
 * Exactly Stripes' set ("action" singular; "actions" is NOT a base package —
 * that is what yields jpetstore's /actions/Catalog.action).
 */
const BASE_PACKAGES = new Set(["web", "www", "stripes", "action"]);

/** Stripes strips these class-name suffixes, longest first. */
const NAME_SUFFIXES = ["ActionBean", "Action", "Bean"];

/**
 * Census-wide set of class names known to descend from ActionBean — fixpoint
 * over superclass/interface names so indirect descendants (CheckoutBean →
 * BaseSupport → AbstractActionBean) are found, not just direct ones (review
 * finding). Simple names only; cross-package name collisions are acceptable
 * at census granularity (Stage-15's class index refines linkage).
 */
export function buildActionBeanIndex(
  factsByPath: Map<string, JavaFileFacts>,
): Set<string> {
  interface ClassLink {
    name: string;
    superclass: string | null;
    interfaces: string[];
  }
  const links: ClassLink[] = [];
  for (const facts of factsByPath.values()) {
    for (const cls of facts.classes) {
      if (cls.kind !== "class") continue;
      links.push({
        name: cls.name,
        superclass: cls.superclass,
        interfaces: cls.interfaces.map((i) => i.name),
      });
    }
  }

  const set = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const link of links) {
      if (set.has(link.name)) continue;
      if (isActionBeanLink(link.name, link.superclass, link.interfaces, set)) {
        set.add(link.name);
        grew = true;
      }
    }
  }
  return set;
}

function isActionBeanLink(
  name: string,
  superclass: string | null,
  interfaces: string[],
  known: Set<string>,
): boolean {
  return (
    name.endsWith("ActionBean") ||
    (superclass !== null &&
      (superclass.endsWith("ActionBean") || known.has(superclass))) ||
    interfaces.some(
      (i) => i === "ActionBean" || i.endsWith(".ActionBean") || known.has(i),
    )
  );
}

export function extractStripesRoutes(
  relPath: string,
  facts: JavaFileFacts,
  actionBeanIndex: Set<string>,
): UnassignedRoute[] {
  const routes: UnassignedRoute[] = [];
  for (const cls of facts.classes) {
    if (cls.kind !== "class") continue;

    const urlBinding = cls.annotations.find((a) => a.name === "UrlBinding");
    if (urlBinding) {
      const raw = urlBinding.args["value"]?.strings[0];
      if (raw) {
        routes.push({
          method: "ANY",
          path: normalizePath(raw),
          rawPath: raw,
          kind: "form",
          framework: "stripes",
          filePath: relPath,
          line: urlBinding.line,
          handler: cls.name,
          notes: [],
        });
      }
      continue;
    }

    // Name-based convention: concrete ActionBean without @UrlBinding.
    // Abstract bases (jpetstore AbstractActionBean) are not addressable.
    if (cls.isAbstract || !actionBeanIndex.has(cls.name)) {
      continue;
    }
    const raw = nameBasedBinding(facts.packageName, cls.name);
    routes.push({
      method: "ANY",
      path: normalizePath(raw),
      rawPath: raw,
      kind: "form",
      framework: "stripes",
      filePath: relPath,
      line: cls.line,
      handler: cls.name,
      notes: ["name-based-convention"],
    });
  }
  return routes;
}

/**
 * NameBasedActionResolver: org.mybatis.jpetstore.web.actions.CatalogActionBean
 * → /actions/Catalog.action (segments after the last base package + stripped
 * class name + ".action").
 */
export function nameBasedBinding(packageName: string | null, className: string): string {
  let base = className;
  for (const suffix of NAME_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }

  const segments: string[] = [];
  if (packageName) {
    const parts = packageName.split(".");
    let lastBaseIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (BASE_PACKAGES.has(parts[i])) lastBaseIdx = i;
    }
    if (lastBaseIdx !== -1) segments.push(...parts.slice(lastBaseIdx + 1));
  }

  return `/${[...segments, base].join("/")}.action`;
}
