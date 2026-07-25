/**
 * People-facing form of a lowercase teammate callsign. Display-only: never
 * write this back into config, filters, URLs, or commands. Future command
 * palettes should use this as their primary label while searching raw values.
 */
export function displayCallsign(raw?: string | null): string {
  const slug = (raw ?? '').trim();
  if (!slug) return '';
  return slug
    .split('-')
    .map(segment => (segment ? segment[0]!.toUpperCase() + segment.slice(1) : segment))
    .join('-');
}
