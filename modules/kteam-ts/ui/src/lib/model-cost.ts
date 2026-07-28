// RE-EXPORT SHIM. The price registry and the token maths moved to
// `src/model-cost.ts` so the daemon can price a session server-side — per-group
// cost cannot be derived from group token sums, because each session carries its
// own pricing model and validity window.
//
// This file stays because the import path is the UI's contract: components and
// tests keep importing `../lib/model-cost`, and there is exactly ONE definition
// of what a token costs on either side of the boundary. `ui/src/lib/api.ts`
// already reaches across to `src/analytics-types` the same way.
//
// Do not add pricing logic here. Add it to `src/model-cost.ts`.

export * from '../../../src/model-cost';
