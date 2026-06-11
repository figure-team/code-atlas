// /understand-map domain-map module (ADR-001). Stage-14 surface:
// S1 full census + S2 route/entry-point extraction, persisted to .spec/map/.
export * from "./types.js";
export {
  buildCensus,
  isTestPath,
  langForPath,
  createCensusIgnoreFilter,
  UA_DEFAULT_IGNORE_PATTERNS,
} from "./census.js";
export {
  normalizePath,
  routeNaturalKey,
  assignRouteIds,
  sortRoutes,
  sortBatchEntries,
  batchEntryId,
} from "./route-key.js";
export {
  specMapDir,
  stableJson,
  writeMapArtifact,
  writeCensus,
  writeRoutes,
} from "./persist.js";
export { extractRoutes, scanDomainMap, gitCommitHash } from "./extract.js";
export { nameBasedBinding } from "./routes/stripes.js";
export { classifyNextJsFile } from "./routes/nextjs.js";
