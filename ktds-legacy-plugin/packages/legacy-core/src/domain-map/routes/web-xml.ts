import { normalizePath } from "../route-key.js";
import type { RouteEntry } from "../types.js";

// S2 web.xml servlet-mapping extraction — a speclinker gap closed here: it
// only read context-path prefixes; legacy *.do-era apps route real business
// servlets through web.xml, so this is part of the full route census.
// Regex parsing is deliberate: no XML grammar in scope, and web.xml is a
// rigid container format (speclinker precedent).

type UnassignedRoute = Omit<RouteEntry, "routeId">;

/** Front-controller servlets — kept in the census but flagged: they dispatch, they aren't business routes. */
const DISPATCHER_CLASS =
  /DispatcherServlet|ActionServlet|FacesServlet|CXFServlet|JspServlet/;

/**
 * Shared XML preprocessing for regex extraction:
 * - blank out comments, preserving every newline AND total length, so legacy
 *   web.xml's commented-out mappings stop matching as live routes (review
 *   finding) without shifting lineAt offsets
 * - unwrap CDATA markers (newlines inside the body survive, so line numbers
 *   stay exact; only column offsets shift, which nothing consumes)
 */
export function preprocessXml(content: string): string {
  let out = content.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner);
  return out;
}

export function extractWebXmlRoutes(
  relPath: string,
  rawContent: string,
): UnassignedRoute[] {
  const content = preprocessXml(rawContent);

  // servlet-name → handler (servlet-class or jsp-file)
  const servletHandlers = new Map<string, { handler: string; isJspFile: boolean }>();
  for (const block of matchBlocks(content, "servlet")) {
    const name = tagValue(block.body, "servlet-name");
    if (!name) continue;
    const servletClass = tagValue(block.body, "servlet-class");
    const jspFile = tagValue(block.body, "jsp-file");
    if (servletClass) {
      servletHandlers.set(name, { handler: servletClass, isJspFile: false });
    } else if (jspFile) {
      servletHandlers.set(name, { handler: jspFile, isJspFile: true });
    }
  }

  const routes: UnassignedRoute[] = [];
  for (const block of matchBlocks(content, "servlet-mapping")) {
    const name = tagValue(block.body, "servlet-name");
    if (!name) continue;
    const entry = servletHandlers.get(name) ?? null;
    const patternRe = /<url-pattern(?:\s[^>]*)?>\s*([^<]*?)\s*<\/url-pattern>/g;
    let m: RegExpExecArray | null;
    while ((m = patternRe.exec(block.body)) !== null) {
      const rawPath = m[1];
      if (rawPath === "") continue;
      const notes: string[] = [];
      if (entry && DISPATCHER_CLASS.test(entry.handler)) notes.push("dispatcher");
      if (!entry) notes.push("unresolved-servlet");
      routes.push({
        method: "ANY",
        // Extension mappings ("*.do") are not URL paths — keep them verbatim
        // instead of inventing a leading slash.
        path: rawPath.startsWith("*.") ? rawPath : normalizePath(rawPath),
        rawPath,
        kind: "servlet",
        framework: "webxml",
        filePath: relPath,
        line: lineAt(content, block.index + m.index),
        handler: entry?.handler ?? null,
        notes,
      });
    }
  }
  return routes;
}

interface Block {
  body: string;
  /** Offset of the body within the whole document (line computation). */
  index: number;
}

/**
 * `<tag>` blocks, tolerating attributes and whitespace in the open tag
 * (`<servlet-mapping id="m1">` is valid XML and real web.xml files carry
 * such ids — the literal-`<tag>` form silently lost those routes; review
 * finding). `<servlet…>` cannot over-match `<servlet-mapping…>` because the
 * optional group requires whitespace before any attribute.
 */
function matchBlocks(content: string, tag: string): Block[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: Block[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ body: m[1], index: m.index + m[0].indexOf(">") + 1 });
  }
  return out;
}

function tagValue(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${tag}>`).exec(body);
  return m ? m[1] : null;
}

export function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
