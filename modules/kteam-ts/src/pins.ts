// Barrel for the daemon-owned pins subsystem, so the (contended) wiring files —
// api-server.ts, daemon-entry.ts, index.ts — each gain ONE import line and no
// knowledge of the layout:
//
//     import { PinService, PinApi, isPinPath, pinWardenDenial } from './pins';
//
// Shape follows tasks.ts exactly, for the same reason: the subsystem type-checks
// and tests on its own while the shared daemon files are edited by other people.

export * from './pins-types';
export {
  PinStore,
  isSafeSessionId,
  pinFile,
  parsePin,
  parsePinFile,
  dedupePins,
  applyCaps,
  toPreview,
  validateNoteText,
  serializeSnapshot,
  type PinStoreRole,
  type PinStoreOptions,
} from './pins-store';
export { PinService, type PinDeps, type AddPinInput } from './pins-service';
export {
  PinApi,
  isPinPath,
  matchPinRoute,
  pinWardenDenial,
  parsePinActionBody,
  pinErrorStatus,
  pinErrorBody,
  type PinApiService,
  type PinApiRequest,
  type PinRoute,
  type PinAction,
} from './pins-api';
export {
  parsePinCli,
  pinCliRequest,
  renderPinCli,
  renderPinList,
  PIN_CLI_USAGE,
  type PinCliCommand,
  type PinCliRequest,
} from './pins-cli';
