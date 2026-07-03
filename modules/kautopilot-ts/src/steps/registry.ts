import type { StepDef } from "../core/descriptor";
import { PLAN_STEPS } from "./plan";

// ============================================================================
// The flat session machine: one ordered registry of every step across all
// phases. Steps are keyed by name; transitions are returned by each handler
// (run/finalize), so the registry is just a lookup table. (SPEC §13 #1)
// ============================================================================

const ALL_STEPS: StepDef[] = [...PLAN_STEPS];

const REGISTRY = new Map<string, StepDef>(ALL_STEPS.map((s) => [s.name, s]));

export function getStep(name: string): StepDef | undefined {
	return REGISTRY.get(name);
}
