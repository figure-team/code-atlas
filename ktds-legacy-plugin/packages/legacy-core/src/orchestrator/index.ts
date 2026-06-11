import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../config/index.js";
import {
  mergeDomainGraph,
  readDomainGraphFile,
  readKnowledgeGraph,
} from "../kg-reader/index.js";
import { kgFingerprint } from "../domain-map/extract.js";
import { validateClaims, computeInferredRatio } from "../evidence/index.js";
import { generateDocs, renderMarkdown, type ProseProvider } from "../doc-generator/index.js";
import { acquireLock, releaseLock, withStaging, publishStaging } from "../lock/index.js";
import { registerDraft } from "../doc-state/index.js";
import { logEvent } from "../audit/index.js";
import type { Claim } from "../types.js";

/**
 * /understand-docs 의 핵심 흐름 (plan §3.2 데이터 흐름) — 결정론 코드 부분.
 * lock → graph 로드(version/fingerprint 가드) → 5종 생성(staging) → 근거 검증 →
 * [추정] 비율 게이트 → atomic publish → DRAFT 등록 + 감사. 실패 시 staging 폐기 + RUN_ABORTED.
 *
 * 실제 LLM 산문은 ProseProvider(host CLI/Claude)가 주입. 보안 게이트는 Phase 2.
 */
export interface PipelineOptions {
  runId: string;
  /** LLM 산문 주입자. 미지정 시 skeleton-only(근거·구조만). */
  prose?: ProseProvider;
}

export interface PipelineResult {
  runId: string;
  published: string[];
  docsDir: string;
}

export class RunAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAbortedError";
  }
}

export async function runDocsPipeline(
  projectRoot: string,
  options: PipelineOptions
): Promise<PipelineResult> {
  const specDir = join(projectRoot, ".spec");
  const docsDir = join(projectRoot, "docs");
  const graphPath = join(projectRoot, ".understand-anything", "knowledge-graph.json");
  const config = await loadConfig(projectRoot);

  let phase: "generate" | "publish" = "generate";
  const lock = await acquireLock(specDir);
  if (lock.staleRemoved) await logEvent(specDir, "STALE_LOCK_REMOVED", { runId: options.runId });

  try {
    // preflight: KG 부재는 ENOENT 그대로 죽는 대신 행동 가능한 안내로 (D4)
    let graph;
    try {
      graph = await readKnowledgeGraph(graphPath, {
        supportedVersions: config.supportedSchemaVersions,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunAbortedError(
          "knowledge-graph.json 없음 — 먼저 /understand를 실행하세요",
        );
      }
      throw err;
    }

    // domain-graph 병합 스텝 (Stage-18.1, ADR D4 — ktds 측 수정 1곳).
    // /understand-map(자체) 또는 U-A /understand-domain 산출물 모두 수용.
    const domainRaw = await readDomainGraphFile(
      join(projectRoot, ".understand-anything", "domain-graph.json"),
    );
    if (domainRaw) {
      // freshness 경고 (18.2): /understand-map emit 시점에 기록한 KG
      // fingerprint·commit이 현재와 다르면 도메인 분석이 낡았다 — 차단은
      // 아니고(문서 4종은 유효) 재실행 안내만.
      const ktdsMap = (domainRaw as { ktdsMap?: Record<string, unknown> }).ktdsMap;
      if (ktdsMap) {
        const currentKg = await kgFingerprint(projectRoot);
        if (
          typeof ktdsMap.kgFingerprintAtEmit === "string" &&
          currentKg !== null &&
          ktdsMap.kgFingerprintAtEmit !== currentKg
        ) {
          console.warn(
            "[understand-docs] 도메인 분석이 knowledge-graph보다 오래됨 — /understand-map emit 재실행을 권장합니다.",
          );
        }
        if (
          typeof ktdsMap.generatedFromCommit === "string" &&
          graph.project.gitCommitHash &&
          ktdsMap.generatedFromCommit !== graph.project.gitCommitHash
        ) {
          console.warn(
            `[understand-docs] domain-graph 생성 commit(${String(ktdsMap.generatedFromCommit).slice(0, 8)})이 KG commit(${graph.project.gitCommitHash.slice(0, 8)})과 다릅니다.`,
          );
        }
      }
      graph = mergeDomainGraph(graph, domainRaw).graph;
    }
    // preflight: domain 노드 부재 → 03_feature-spec이 비는 갭(step6 실측)을
    // 조용히 지나치지 않고 안내한다 (차단은 아님 — 4종 문서는 유효)
    if (!graph.nodes.some((n) => n.kind === "domain")) {
      console.warn(
        "[understand-docs] domain 노드 없음 — 03_feature-spec이 비게 됩니다. /understand-map(권장) 또는 /understand-domain을 먼저 실행하세요.",
      );
    }
    // LLM_REQUEST: 실제 LLM(prose) 사용 시에만 기록 (skeleton-only 실행은 LLM 호출 없음)
    if (options.prose) {
      await logEvent(specDir, "LLM_REQUEST", {
        runId: options.runId,
        detail: { networkType: config.networkType },
      });
    }

    const { stagingDir } = await withStaging(specDir, options.runId, async (staging) => {
      const docs = await generateDocs(graph, { prose: options.prose });
      for (const doc of docs) {
        const claims: Claim[] = doc.sections.flatMap((s) => s.claims);

        // 근거 스키마 검증: CONFIRMED_AI ∧ evidence 없음 → RETURNED (A5)
        if (validateClaims(claims) === "RETURNED") {
          throw new RunAbortedError(`${doc.filename}: CONFIRMED_AI without evidence (RETURNED)`);
        }
        // [추정] 비율 게이트 (config 임계값; block 초과 → RUN_ABORTED)
        const ratio = computeInferredRatio(claims);
        if (ratio > config.inferredRatioBlockThreshold) {
          throw new RunAbortedError(
            `${doc.filename}: inferred ratio ${(ratio * 100).toFixed(0)}% exceeds block ` +
              `${(config.inferredRatioBlockThreshold * 100).toFixed(0)}%`
          );
        }
        await writeFile(join(staging, doc.filename), renderMarkdown(doc), "utf-8");
      }
    });

    phase = "publish";
    const published = (await publishStaging(stagingDir, docsDir)).sort();
    for (const f of published) {
      await registerDraft(specDir, f); // 신규 문서 = DRAFT
      await logEvent(specDir, "DOC_GENERATED", { doc: f, runId: options.runId });
    }
    return { runId: options.runId, published, docsDir };
  } catch (err) {
    // 감사 기록 실패가 원인 오류를 가리지 않게 한다. phase로 publish 중 부분발행 구분 가능.
    try {
      await logEvent(specDir, "RUN_ABORTED", {
        runId: options.runId,
        detail: { phase, error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      /* swallow audit failure; original error wins */
    }
    throw err;
  } finally {
    await releaseLock(specDir);
  }
}
