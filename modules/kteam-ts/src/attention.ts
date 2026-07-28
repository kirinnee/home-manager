// Barrel keeps all shared-file wiring narrow, matching pins.ts/tasks.ts.

export * from './attention-types';
export {
  AttentionStore,
  isSafeAttentionSessionId,
  attentionFile,
  parseAttentionItem,
  parseResolvedAttentionItem,
  parseAttentionFile,
  serializeAttentionItem,
  serializeResolvedAttentionItem,
  serializeAttentionFile,
  type AttentionFile,
  type AttentionRead,
  type AttentionState,
  type AttentionMutation,
  type AttentionStoreRole,
  type AttentionStoreOptions,
} from './attention-store';
export { AttentionService, type AttentionDeps, type AddAttentionInput } from './attention-service';
export {
  AttentionApi,
  resolveAttentionApiActor,
  isAttentionPath,
  matchAttentionRoute,
  attentionWardenDenial,
  parseAttentionActionBody,
  attentionErrorStatus,
  attentionErrorBody,
  type AttentionApiService,
  type AttentionActorLookup,
  type AttentionApiRequest,
  type AttentionRoute,
  type AttentionAction,
} from './attention-api';
export {
  parseAttentionCli,
  attentionCliRequest,
  renderAttentionCli,
  renderAttentionList,
  renderAttentionHistory,
  ATTENTION_CLI_USAGE,
  type AttentionCliCommand,
  type AttentionCliRequest,
} from './attention-cli';
export { AttentionSources, type AttentionSessionSource, type AttentionTaskSource } from './attention-sources';
export { notificationPolicyForAttention, notificationCreatesAttention } from './notification-policy';
