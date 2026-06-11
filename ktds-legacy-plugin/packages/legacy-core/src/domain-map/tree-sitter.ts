import { createRequire } from "node:module";

// Self-contained web-tree-sitter loader. Deliberately NOT importing
// @understand-anything/core's TreeSitterPlugin: legacy-core's only U-A
// dependency is the on-disk graph contract (ADR D5 / plan principle 3), so the
// grammar comes from our own package.json deps (public npm, not U-A internals).

const require = createRequire(import.meta.url);

export type JavaNode = import("web-tree-sitter").Node;

type ParserModule = typeof import("web-tree-sitter");

let parserModule: Promise<ParserModule> | null = null;
let javaLanguage: Promise<import("web-tree-sitter").Language> | null = null;

async function loadModule(): Promise<ParserModule> {
  if (!parserModule) {
    parserModule = import("web-tree-sitter").then(async (mod) => {
      await mod.Parser.init();
      return mod;
    });
  }
  return parserModule;
}

async function loadJavaLanguage(): Promise<import("web-tree-sitter").Language> {
  if (!javaLanguage) {
    javaLanguage = loadModule().then((mod) =>
      mod.Language.load(require.resolve("tree-sitter-java/tree-sitter-java.wasm")),
    );
  }
  return javaLanguage;
}

/**
 * Parse Java source and run `fn` on the root node. Tree and parser are
 * released afterwards — web-tree-sitter objects live on the WASM heap and leak
 * unless delete()d (one parse per file over 50K-LOC repos, M4).
 */
export async function withJavaTree<T>(
  source: string,
  fn: (root: JavaNode) => T,
): Promise<T> {
  const mod = await loadModule();
  const lang = await loadJavaLanguage();
  const parser = new mod.Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  try {
    if (!tree) throw new Error("tree-sitter returned no tree for Java source");
    return fn(tree.rootNode);
  } finally {
    tree?.delete();
    parser.delete();
  }
}

// ── Shared AST helpers ─────────────────────────────────────────────────────

export function childrenOfType(node: JavaNode, type: string): JavaNode[] {
  const out: JavaNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) out.push(child);
  }
  return out;
}

export function firstChildOfType(node: JavaNode, type: string): JavaNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) return child;
  }
  return null;
}

/** 1-based line of a node (tree-sitter rows are 0-based). */
export function lineOf(node: JavaNode): number {
  return node.startPosition.row + 1;
}
