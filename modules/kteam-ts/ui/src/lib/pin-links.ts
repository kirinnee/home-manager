// Pin composer labels and open-request identity.
//
// Pins remain a feature, but are deliberately outside the canonical reference
// grammar. No sigil, resolver, remark transform, or live-link rendering lives
// here.

export interface PinReferenceLookup {
  sessionId: string;
  pinId: string;
}

export interface ResolvedPinReference extends PinReferenceLookup {
  label: string;
}

export type PinReferenceResolver = (lookup: PinReferenceLookup) => ResolvedPinReference | null | undefined;

function normalizePinLabel(value: string): string {
  const label = value.replace(/\s+/gu, ' ').trim();
  return label || 'Untitled pin';
}

/** Compatibility entry point for the excluded autocomplete provider. A picked
 * pin now inserts readable text only, never a reference or a dead destination. */
export function pinReferenceMarkdown(reference: ResolvedPinReference): string {
  return `pin: ${normalizePinLabel(reference.label)}`;
}
