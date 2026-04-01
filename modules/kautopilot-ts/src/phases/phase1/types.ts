import type { PhaseContext } from '../machine';
import type { TypeConfig, DeliveryKind } from '../../core/types';

export interface Phase1Context extends PhaseContext {
  ticketType?: string;
  typeConfig?: TypeConfig;
  deliveryKind?: DeliveryKind;
}

export type Phase1StateMap = Record<string, (ctx: Phase1Context) => Promise<string | null>>;
