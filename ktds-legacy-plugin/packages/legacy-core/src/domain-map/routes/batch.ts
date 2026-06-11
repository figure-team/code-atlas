import type { JavaFileFacts } from "../java-facts.js";
import { batchEntryId } from "../route-key.js";
import type { BatchEntry } from "../types.js";
import { lineAt, preprocessXml } from "./web-xml.js";

// S2 batch/scheduler entry points: @Scheduled methods, Quartz XML beans,
// <task:scheduled> XML, public static void main. Batch flows have no
// (method, path) — their natural key is "batch:<relPath>#<Class.symbol>".

export function extractJavaBatchEntries(
  relPath: string,
  facts: JavaFileFacts,
): BatchEntry[] {
  const entries: BatchEntry[] = [];
  for (const cls of facts.classes) {
    if (cls.kind !== "class") continue;
    for (const method of cls.methods) {
      // Repeatable @Scheduled: one entry per annotation; the line qualifier
      // keeps entryIds unique without resorting to ordinals (A15).
      const scheduledAnns = method.annotations.filter((a) => a.name === "Scheduled");
      for (const ann of scheduledAnns) {
        const symbol =
          scheduledAnns.length > 1
            ? `${cls.name}.${method.name}@L${ann.line}`
            : `${cls.name}.${method.name}`;
        entries.push({
          entryId: batchEntryId(relPath, symbol),
          trigger: "scheduled",
          schedule: scheduleText(ann.args),
          filePath: relPath,
          line: ann.line,
          handler: `${cls.name}#${method.name}`,
          notes: [],
        });
      }
      // @Schedules container: nested annotation args aren't extracted, so
      // report the entry with an explicit container note instead of dropping.
      const container = method.annotations.find((a) => a.name === "Schedules");
      if (container) {
        entries.push({
          entryId: batchEntryId(relPath, `${cls.name}.${method.name}`),
          trigger: "scheduled",
          schedule: null,
          filePath: relPath,
          line: container.line,
          handler: `${cls.name}#${method.name}`,
          notes: ["container:@Schedules"],
        });
      }
      if (
        method.name === "main" &&
        method.isStatic &&
        /String\s*(\[\]|\.\.\.)/.test(method.paramsText)
      ) {
        entries.push({
          entryId: batchEntryId(relPath, `${cls.name}.main`),
          trigger: "main",
          schedule: null,
          filePath: relPath,
          line: method.line,
          handler: `${cls.name}#main`,
          notes: [],
        });
      }
    }
  }
  return entries;
}

function scheduleText(
  args: Record<string, { strings: string[]; refs: string[] }>,
): string | null {
  for (const key of ["cron", "fixedRate", "fixedDelay", "fixedRateString", "fixedDelayString"]) {
    const arg = args[key];
    if (!arg) continue;
    const value = arg.strings[0] ?? arg.refs[0];
    if (value !== undefined) return `${key}=${value}`;
  }
  return null;
}

// ── Spring XML (Quartz / task namespace) ───────────────────────────────────

const QUARTZ_BEAN_CLASS =
  /(org\.springframework\.scheduling\.quartz|org\.quartz)\.\w*(Trigger|JobDetail|SchedulerFactory)\w*/;

interface BeanBlock {
  attrs: string;
  body: string;
  /** Offset of the open tag in the document. */
  index: number;
}

/**
 * Every <bean> in the document, nested ones included, each with its own
 * depth-balanced body. A lazy `<bean>…</bean>` regex truncates at the FIRST
 * close tag, which both corrupts outer bodies and permanently skips nested
 * trigger beans — the standard SchedulerFactoryBean layout puts the
 * CronTrigger bean inside <property name="triggers"><list>…</list></property>
 * and lost ALL entries (review finding, critical).
 */
function findBeanBlocks(content: string): BeanBlock[] {
  const blocks: BeanBlock[] = [];
  const openRe = /<bean\b([^>]*?)(\/?)>/g;
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(content)) !== null) {
    if (open[2] === "/") {
      blocks.push({ attrs: open[1], body: "", index: open.index });
      continue;
    }
    const bodyStart = openRe.lastIndex;
    const tagRe = /<bean\b[^>]*?(\/?)>|<\/bean>/g;
    tagRe.lastIndex = bodyStart;
    let depth = 1;
    let bodyEnd = content.length;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(content)) !== null) {
      if (tag[0] === "</bean>") {
        depth--;
        if (depth === 0) {
          bodyEnd = tag.index;
          break;
        }
      } else if (tag[1] !== "/") {
        depth++;
      }
    }
    blocks.push({ attrs: open[1], body: content.slice(bodyStart, bodyEnd), index: open.index });
  }
  return blocks;
}

/**
 * Quartz/Spring-task signals in XML. speclinker left Quartz XML to an LLM
 * agent (strategies/batch yaml); here it must be deterministic script output.
 */
export function extractXmlBatchEntries(relPath: string, rawContent: string): BatchEntry[] {
  const content = preprocessXml(rawContent);
  const entries: BatchEntry[] = [];

  for (const block of findBeanBlocks(content)) {
    const className = attrValue(block.attrs, "class");
    if (!className || !QUARTZ_BEAN_CLASS.test(className)) continue;
    // Only triggers carry the schedule; JobDetail/SchedulerFactory beans
    // duplicate the same job and would double-count it.
    if (!/Trigger/.test(className)) continue;

    const beanId = attrValue(block.attrs, "id");
    const cron = propertyValue(block.body, "cronExpression");
    const jobRef = propertyRef(block.body, "jobDetail");
    const symbol = beanId ?? simpleClassName(className);
    entries.push({
      entryId: batchEntryId(relPath, symbol),
      trigger: "quartz",
      schedule: cron ? `cron=${cron}` : null,
      filePath: relPath,
      line: lineAt(content, block.index),
      handler: jobRef,
      notes: [],
    });
  }

  // <task:scheduled ref="bean" method="run" cron="..."/>
  const taskRe = /<task:scheduled\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = taskRe.exec(content)) !== null) {
    const attrs = m[1];
    const ref = attrValue(attrs, "ref");
    const method = attrValue(attrs, "method");
    if (!ref || !method) continue;
    const cron = attrValue(attrs, "cron");
    const fixedRate = attrValue(attrs, "fixed-rate");
    const fixedDelay = attrValue(attrs, "fixed-delay");
    const schedule = cron
      ? `cron=${cron}`
      : fixedRate
        ? `fixedRate=${fixedRate}`
        : fixedDelay
          ? `fixedDelay=${fixedDelay}`
          : null;
    entries.push({
      entryId: batchEntryId(relPath, `${ref}.${method}`),
      trigger: "task-xml",
      schedule,
      filePath: relPath,
      line: lineAt(content, m.index),
      handler: `${ref}#${method}`,
      notes: [],
    });
  }

  return entries;
}

function attrValue(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

function propertyValue(body: string, name: string): string | null {
  const m = new RegExp(
    `<property\\s+name="${name}"\\s+value="([^"]*)"|<property\\s+name="${name}"[\\s\\S]*?<value>\\s*([^<]*?)\\s*</value>`,
  ).exec(body);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function propertyRef(body: string, name: string): string | null {
  const m = new RegExp(
    `<property\\s+name="${name}"\\s+ref="([^"]*)"|<property\\s+name="${name}"[\\s\\S]*?<ref\\s+bean="([^"]*)"`,
  ).exec(body);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function simpleClassName(qualified: string): string {
  const idx = qualified.lastIndexOf(".");
  return idx === -1 ? qualified : qualified.slice(idx + 1);
}
