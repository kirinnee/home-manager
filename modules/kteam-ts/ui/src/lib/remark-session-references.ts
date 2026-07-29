// Temporary compatibility export for explicitly excluded owners
// (`SidePane.tsx` and composer-autocomplete providers).
//
// Session reference parsing/rendering was removed. Pins are ordinary pin
// feature data now and have no remark transform or reserved href.

export {
  pinReferenceMarkdown,
  type PinReferenceLookup,
  type PinReferenceResolver,
  type ResolvedPinReference,
} from './pin-links';
