import type { DeliveryKind } from '../../core/types';
import type { PhaseContext } from '../machine';
import type { TestingLevel } from './triage';

export interface SpecAmendmentContext {
  previousSpecPath: string;
  reason: string;
  previousVersion: number;
}

export interface Phase1Context extends PhaseContext {
  deliveryKind?: DeliveryKind;
  verification?: {
    hasAssumptions: boolean;
    testing: TestingLevel;
    hasValidators: boolean;
  };
  specAmendmentContext?: SpecAmendmentContext;
}

export type Phase1StateMap = Record<string, (ctx: Phase1Context) => Promise<string | null>>;
