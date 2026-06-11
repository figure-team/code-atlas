import {
  childrenOfType,
  firstChildOfType,
  lineOf,
  withJavaTree,
  type JavaNode,
} from "./tree-sitter.js";

// Single-pass Java fact scanner. One tree-sitter parse per file collects
// everything every extractor needs (annotations, constants, composed
// annotation declarations, main methods), so the route pass never re-parses —
// the deterministic stage must stay under 1 minute at 50K LOC (M4).

export interface JavaAnnotationValue {
  /** String literals resolved at the use site (concatenations of literals included). */
  strings: string[];
  /** Unresolved references (constants): "BASE_PATH", "Constants.BASE", "RequestMethod.GET". */
  refs: string[];
}

export interface JavaAnnotation {
  /** Simple name without "@", e.g. "RequestMapping". */
  name: string;
  line: number;
  /** Keyed by element name; a single positional value is keyed "value". */
  args: Record<string, JavaAnnotationValue>;
}

export interface JavaMethodFacts {
  name: string;
  line: number;
  isStatic: boolean;
  /** Parameter list source text, e.g. "(String[] args)". */
  paramsText: string;
  returnType: string | null;
  annotations: JavaAnnotation[];
  /** Method body source — only ever regex-tested (api/form signals), never parsed. */
  bodyText: string;
  /** 1-based line where the body block starts (anchors bodyText regex hits to file lines). */
  bodyLine: number | null;
}

export interface JavaImport {
  /** Dotted path as written, without "import"/"static"/";"/".*". */
  path: string;
  wildcard: boolean;
  isStatic: boolean;
  line: number;
}

export interface JavaFieldFacts {
  name: string;
  /** Declared type, generics stripped: "List<Order> orders" → "List". */
  typeName: string;
  /**
   * Type identifiers inside the generic arguments: "Map<String, Order>" →
   * ["String", "Order"]. Collection-typed fields are how legacy domain models
   * hold each other — dropping the element type severs those chains.
   */
  typeArgNames: string[];
  line: number;
  /** @Autowired/@Resource/@Inject present (Stage-15 injection signal). */
  injected: boolean;
}

export interface JavaClassFacts {
  name: string;
  /**
   * Dot-joined nesting chain: "Outer.Inner" for nested types, == name for
   * top-level. Keeps the FQN index collision-free when a nested type shares
   * its simple name with a sibling top-level type (review finding).
   */
  qualifiedName: string;
  line: number;
  kind: "class" | "interface" | "annotation" | "enum";
  isAbstract: boolean;
  annotations: JavaAnnotation[];
  superclass: string | null;
  /** 1-based line of the extends clause (precise evidence anchor). */
  superclassLine: number | null;
  interfaces: Array<{ name: string; line: number }>;
  methods: JavaMethodFacts[];
  /** Declared instance fields (Stage-15 call-chain signals). */
  fields: JavaFieldFacts[];
  /** Constructor parameter types, generics stripped (constructor injection). */
  ctorParamTypes: Array<{ typeName: string; line: number }>;
}

export interface JavaFileFacts {
  packageName: string | null;
  imports: JavaImport[];
  /** All classes including nested, in source order. */
  classes: JavaClassFacts[];
  /**
   * String constants declared in this file:
   * "CONST" (file-local lookup) and "ClassName.CONST" (cross-file lookup).
   */
  constants: Map<string, string>;
}

export async function scanJavaFile(source: string): Promise<JavaFileFacts> {
  return withJavaTree(source, (root) => {
    const facts: JavaFileFacts = {
      packageName: extractPackage(root),
      imports: extractImports(root),
      classes: [],
      constants: new Map(),
    };
    collectTypes(root, facts);
    return facts;
  });
}

function extractImports(root: JavaNode): JavaImport[] {
  const out: JavaImport[] = [];
  for (const decl of childrenOfType(root, "import_declaration")) {
    const id =
      firstChildOfType(decl, "scoped_identifier") ??
      firstChildOfType(decl, "identifier");
    if (!id) continue;
    out.push({
      path: id.text,
      wildcard: decl.text.includes(".*"),
      isStatic: /\bimport\s+static\b/.test(decl.text),
      line: lineOf(decl),
    });
  }
  return out;
}

// ── Type declarations ──────────────────────────────────────────────────────

// Enums ARE indexed as types (Stage-15: domain enums are legitimate edge
// targets), but their bodies (enum_body) hold constants/methods in shapes the
// member loop doesn't walk — controllers are never enums; enum-hosted
// constants still surface as "unresolved-constant" notes rather than silent drops.
const TYPE_DECL_KINDS: Record<string, JavaClassFacts["kind"]> = {
  class_declaration: "class",
  interface_declaration: "interface",
  annotation_type_declaration: "annotation",
  record_declaration: "class",
  enum_declaration: "enum",
};

function collectTypes(node: JavaNode, facts: JavaFileFacts, prefix = ""): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const kind = TYPE_DECL_KINDS[child.type];
    if (kind) {
      const cls = extractClass(child, kind, facts, prefix);
      if (cls) facts.classes.push(cls);
      // Recurse into the body for nested types, extending the nesting chain.
      const body = child.childForFieldName("body");
      if (body) collectTypes(body, facts, cls?.qualifiedName ?? prefix);
    } else if (child.type === "program") {
      collectTypes(child, facts, prefix);
    }
  }
}

function extractClass(
  node: JavaNode,
  kind: JavaClassFacts["kind"],
  facts: JavaFileFacts,
  prefix: string,
): JavaClassFacts | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const className = nameNode.text;
  const modifiers = firstChildOfType(node, "modifiers");
  const superclass = extractSuperclass(node);

  const cls: JavaClassFacts = {
    name: className,
    qualifiedName: prefix ? `${prefix}.${className}` : className,
    line: lineOf(node),
    kind,
    isAbstract: modifiers?.text.includes("abstract") ?? false,
    annotations: modifiers ? extractAnnotations(modifiers) : [],
    superclass: superclass?.name ?? null,
    superclassLine: superclass?.line ?? null,
    interfaces: extractInterfaces(node),
    methods: [],
    fields: [],
    ctorParamTypes: [],
  };

  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      if (member.type === "method_declaration") {
        cls.methods.push(extractMethod(member));
      } else if (
        member.type === "field_declaration" ||
        member.type === "constant_declaration"
      ) {
        collectConstants(member, className, facts.constants);
        if (member.type === "field_declaration") {
          collectFields(member, cls.fields);
        }
      } else if (member.type === "constructor_declaration") {
        collectCtorParams(member, cls.ctorParamTypes);
      }
    }
  }

  return cls;
}

const INJECTION_ANNOTATIONS = new Set(["Autowired", "Resource", "Inject"]);

function collectFields(node: JavaNode, into: JavaFieldFacts[]): void {
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return;
  const typeName = stripGenerics(typeNode.text);
  const modifiers = firstChildOfType(node, "modifiers");
  // Static fields are constants/state, not collaborator wiring.
  if (modifiers && /\bstatic\b/.test(modifiers.text)) return;
  const injected = modifiers
    ? extractAnnotations(modifiers).some((a) => INJECTION_ANNOTATIONS.has(a.name))
    : false;
  const typeArgNames = genericArgNames(typeNode.text);
  for (const declarator of childrenOfType(node, "variable_declarator")) {
    const name = declarator.childForFieldName("name")?.text;
    if (!name) continue;
    into.push({ name, typeName, typeArgNames, line: lineOf(node), injected });
  }
}

function collectCtorParams(
  node: JavaNode,
  into: Array<{ typeName: string; line: number }>,
): void {
  const params = node.childForFieldName("parameters");
  if (!params) return;
  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i);
    if (!param) continue;
    let typeNode: JavaNode | null = null;
    if (param.type === "formal_parameter") {
      typeNode = param.childForFieldName("type");
    } else if (param.type === "spread_parameter") {
      // Varargs (Handler... handlers) has no `type` field in the grammar —
      // the type is the named child that is neither modifiers nor declarator
      // (review finding: dropping it severed ctor-injection signals).
      for (let j = 0; j < param.namedChildCount; j++) {
        const c = param.namedChild(j);
        if (c && c.type !== "modifiers" && c.type !== "variable_declarator") {
          typeNode = c;
          break;
        }
      }
    }
    if (!typeNode) continue;
    const line = lineOf(param);
    into.push({ typeName: stripGenerics(typeNode.text), line });
    // Generic arguments are signals too: Service(List<Handler> handlers).
    for (const arg of genericArgNames(typeNode.text)) {
      into.push({ typeName: arg, line });
    }
  }
}

/** Keywords/wildcards that can appear inside generic argument lists. */
const GENERIC_NOISE = new Set(["extends", "super"]);

/**
 * All type identifiers inside the generic argument list, nested generics
 * flattened: "Map<String, List<Order>>" → ["String", "List", "Order"].
 * Resolution downstream discards JDK names as external — better to over-list
 * here than to sever a domain chain.
 */
function genericArgNames(typeText: string): string[] {
  const open = typeText.indexOf("<");
  const close = typeText.lastIndexOf(">");
  if (open === -1 || close <= open) return [];
  const inner = typeText.slice(open + 1, close);
  const out: string[] = [];
  for (const m of inner.matchAll(/[A-Za-z_$][\w$.]*/g)) {
    if (!GENERIC_NOISE.has(m[0])) out.push(m[0]);
  }
  return out;
}

function extractSuperclass(node: JavaNode): { name: string; line: number } | null {
  const sc = node.childForFieldName("superclass");
  if (!sc) return null;
  // superclass node is "extends X" — take the trailing type text.
  const name = sc.text.replace(/^extends\s+/, "").trim();
  return name ? { name, line: lineOf(sc) } : null;
}

function extractInterfaces(node: JavaNode): Array<{ name: string; line: number }> {
  const ifaces = node.childForFieldName("interfaces");
  if (!ifaces) return [];
  const list = firstChildOfType(ifaces, "type_list");
  if (!list) return [];
  const out: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < list.namedChildCount; i++) {
    const t = list.namedChild(i);
    if (t) out.push({ name: stripGenerics(t.text), line: lineOf(t) });
  }
  return out;
}

function extractMethod(node: JavaNode): JavaMethodFacts {
  const modifiers = firstChildOfType(node, "modifiers");
  const body = node.childForFieldName("body");
  return {
    name: node.childForFieldName("name")?.text ?? "",
    line: lineOf(node),
    isStatic: /\bstatic\b/.test(modifiers?.text ?? ""),
    paramsText: node.childForFieldName("parameters")?.text ?? "()",
    returnType: node.childForFieldName("type")?.text ?? null,
    annotations: modifiers ? extractAnnotations(modifiers) : [],
    bodyText: body?.text ?? "",
    bodyLine: body ? lineOf(body) : null,
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

function collectConstants(
  node: JavaNode,
  className: string,
  constants: Map<string, string>,
): void {
  // Interface constant_declarations are implicitly static final; for
  // field_declarations require both keywords — only immutable values are safe
  // to inline into route paths.
  if (node.type === "field_declaration") {
    const modifiers = firstChildOfType(node, "modifiers");
    const text = modifiers?.text ?? "";
    if (!/\bstatic\b/.test(text) || !/\bfinal\b/.test(text)) return;
  }
  for (const declarator of childrenOfType(node, "variable_declarator")) {
    const name = declarator.childForFieldName("name")?.text;
    const value = declarator.childForFieldName("value");
    if (!name || !value) continue;
    const literal = literalString(value);
    if (literal === null) continue;
    if (!constants.has(name)) constants.set(name, literal);
    constants.set(`${className}.${name}`, literal);
  }
}

/** Resolve a node to a string iff it is a literal or a concatenation of literals. */
function literalString(node: JavaNode): string | null {
  if (node.type === "string_literal") {
    return unquote(node.text);
  }
  if (node.type === "binary_expression") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const op = node.childForFieldName("operator");
    if (!left || !right || (op && op.text !== "+")) return null;
    const l = literalString(left);
    const r = literalString(right);
    return l !== null && r !== null ? l + r : null;
  }
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChild(0);
    return inner ? literalString(inner) : null;
  }
  return null;
}

// ── Annotations ────────────────────────────────────────────────────────────

export function extractAnnotations(modifiers: JavaNode): JavaAnnotation[] {
  const out: JavaAnnotation[] = [];
  for (let i = 0; i < modifiers.namedChildCount; i++) {
    const child = modifiers.namedChild(i);
    if (!child) continue;
    if (child.type === "marker_annotation") {
      const name = simpleName(child.childForFieldName("name")?.text ?? "");
      if (name) out.push({ name, line: lineOf(child), args: {} });
    } else if (child.type === "annotation") {
      const name = simpleName(child.childForFieldName("name")?.text ?? "");
      if (!name) continue;
      const args: Record<string, JavaAnnotationValue> = {};
      const argList = child.childForFieldName("arguments");
      if (argList) extractAnnotationArgs(argList, args);
      out.push({ name, line: lineOf(child), args });
    }
  }
  return out;
}

function extractAnnotationArgs(
  argList: JavaNode,
  args: Record<string, JavaAnnotationValue>,
): void {
  for (let i = 0; i < argList.namedChildCount; i++) {
    const child = argList.namedChild(i);
    if (!child) continue;
    if (child.type === "line_comment" || child.type === "block_comment") {
      // Comments are named children too — without this they'd be treated as a
      // positional value and clobber the real one (review finding).
      continue;
    }
    if (child.type === "element_value_pair") {
      const key = child.childForFieldName("key")?.text ?? "value";
      const value = child.childForFieldName("value");
      if (value) args[key] = extractValue(value);
    } else {
      // Positional value: @RequestMapping("/path"). Merge rather than assign —
      // stray named children must never erase an already-collected value.
      const existing = args["value"] ?? (args["value"] = { strings: [], refs: [] });
      collectValueInto(child, existing);
    }
  }
}

function extractValue(node: JavaNode): JavaAnnotationValue {
  const value: JavaAnnotationValue = { strings: [], refs: [] };
  collectValueInto(node, value);
  return value;
}

function collectValueInto(node: JavaNode, into: JavaAnnotationValue): void {
  if (node.type === "element_value_array_initializer") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === "line_comment" || child.type === "block_comment") continue;
      collectValueInto(child, into);
    }
    return;
  }
  const literal = literalString(node);
  if (literal !== null) {
    into.strings.push(literal);
    return;
  }
  if (
    node.type === "identifier" ||
    node.type === "field_access" ||
    node.type === "scoped_identifier"
  ) {
    into.refs.push(node.text);
    return;
  }
  if (node.type === "binary_expression") {
    // Mixed concat (CONST + "/suffix"): not foldable here without the
    // cross-file constant index, so surface the whole expression as a ref —
    // resolvePaths folds it later, or reports it unresolved. Never drop.
    into.refs.push(node.text);
    return;
  }
  if (node.type === "decimal_integer_literal") {
    into.strings.push(node.text);
  }
  // Other expression kinds (class literals…) are irrelevant to routes.
}

// ── Small helpers ──────────────────────────────────────────────────────────

function extractPackage(root: JavaNode): string | null {
  const pkg = firstChildOfType(root, "package_declaration");
  if (!pkg) return null;
  const id =
    firstChildOfType(pkg, "scoped_identifier") ?? firstChildOfType(pkg, "identifier");
  return id?.text ?? null;
}

/** "org.springframework.web.bind.annotation.GetMapping" → "GetMapping". */
function simpleName(qualified: string): string {
  const idx = qualified.lastIndexOf(".");
  return idx === -1 ? qualified : qualified.slice(idx + 1);
}

function stripGenerics(type: string): string {
  const idx = type.indexOf("<");
  return (idx === -1 ? type : type.slice(0, idx)).trim();
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}
