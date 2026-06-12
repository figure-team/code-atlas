// /understand-impact (Stage-19, ADR-002) public surface. Each stage (T1..T9)
// adds its exports here without touching other module barrels.
export * from "./types.js";
export {
  buildAdjacency,
  reachClosure,
  computeFanIn,
  type AdjEntry,
  type ReachDirection,
  type ReachedFile,
} from "./reach.js";
export { computeApiImpact, type ApiImpactResult } from "./api.js";
export {
  computePersistenceImpact,
  PERSISTENCE_NOTE,
  type PersistenceInputs,
} from "./persistence.js";
export { computeFlowImpact, type FlowImpactResult } from "./flow.js";
export {
  verifyImpactClaims,
  IMPACT_VERIFY_FILENAME,
  ImpactVerifyReportSchema,
  type ImpactClaimItem,
  type ImpactVerifyReport,
  type VerifiedImpactItem,
} from "./verify.js";
export {
  analyzeImpact,
  buildImpactReport,
  loadImpactInputs,
  loadKgTableCatalog,
  buildMapperInfo,
  ImpactInputMissingError,
  type AnalyzeImpactResult,
  type ImpactInputs,
  type ImpactExtras,
} from "./engine.js";
export {
  buildChangeImpact,
  publishChangeImpact,
  CHANGE_IMPACT_FILENAME,
  IMPACT_STATUS_LINE,
} from "./doc.js";
