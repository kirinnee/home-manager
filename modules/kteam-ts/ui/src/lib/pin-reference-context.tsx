// Pin picker identity helpers.
//
// The daemon-backed pins store is already hydrated by the foreground session
// header and converges through pins.updated. This provider subscribes once and
// builds a read-only identity index; individual Markdown blocks never start a
// second fetch or event stream. Optimistic echoes have no server-stamped `by`
// field, so they are deliberately excluded until the authoritative snapshot
// replaces them.

import { type PinStore } from './pins';
import { type PinReferenceResolver, type ResolvedPinReference } from './pin-links';
const MAX_PIN_REFERENCE_LABEL = 72;

function compactLabel(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return 'Untitled pin';
  return compact.length <= MAX_PIN_REFERENCE_LABEL
    ? compact
    : `${compact.slice(0, MAX_PIN_REFERENCE_LABEL - 1).trimEnd()}…`;
}

/** Payload-tolerant on purpose: diagram pins may add presentation fields, but
 * reference identity remains `session + id`. Prefer human copy and fall back
 * honestly without widening the pin payload schema here. */
export function resolvedPinReference(sessionId: string, value: unknown): ResolvedPinReference | null {
  if (!value || typeof value !== 'object') return null;
  const pin = value as Record<string, unknown>;
  if (typeof pin['id'] !== 'string' || !pin['id']) return null;
  // Server provenance is our positive proof that this is not an optimistic
  // client echo whose provisional id will disappear on reconciliation.
  if (pin['by'] !== 'human' && pin['by'] !== 'agent') return null;
  const copy = ['text', 'preview', 'title', 'label', 'caption', 'alt']
    .map(field => pin[field])
    .find(candidate => typeof candidate === 'string' && candidate.trim().length > 0);
  const kind = typeof pin['kind'] === 'string' && pin['kind'].trim() ? `${pin['kind']} pin` : 'Untitled pin';
  return {
    sessionId,
    pinId: pin['id'],
    label: compactLabel(typeof copy === 'string' ? copy : kind),
  };
}

export function createPinReferenceResolver(store: PinStore): PinReferenceResolver {
  const index = new Map<string, ResolvedPinReference>();
  for (const [sessionId, entry] of Object.entries(store.sessions)) {
    for (const pin of entry.pins) {
      const resolved = resolvedPinReference(sessionId, pin);
      if (resolved) index.set(`${sessionId}\u0000${resolved.pinId}`, resolved);
    }
  }
  return lookup => index.get(`${lookup.sessionId}\u0000${lookup.pinId}`) ?? null;
}
