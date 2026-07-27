// SETTINGS CATALOG — one declarative source for the Settings surface and the
// command palette. Labels, descriptions, anchors and search terms live here so
// adding a setting cannot silently make its palette entry drift from the UI.

export type SettingId = 'text-size' | 'density' | 'theme' | 'chat-width' | 'dictation';

export interface SettingDefinition {
  id: SettingId;
  label: string;
  description: string;
  /** Extra words people are likely to type into Cmd/Ctrl+K. */
  keywords: readonly string[];
}

export const SETTINGS_DEFINITIONS: readonly SettingDefinition[] = [
  {
    id: 'text-size',
    label: 'Text size',
    description:
      'Enlarge text across the whole interface. Labels and line boxes reflow, while padding, gaps, and touch-target floors stay fixed. Browser zoom, pinch zoom, and operating-system scaling remain available.',
    keywords: ['font', 'type', 'large', 'larger', 'readability', 'zoom', 'appearance'],
  },
  {
    id: 'density',
    label: 'Density',
    description:
      'Choose how much session detail the dashboard renders. Compact is the phone default; Full is the desktop default.',
    keywords: ['dashboard', 'detail', 'compact', 'minimal', 'full', 'rows', 'layout'],
  },
  {
    id: 'chat-width',
    label: 'Chat width',
    description:
      'Choose whether the conversation fills the pane or is capped at a readable measure and centred. Mostly a desktop control — a phone is already narrower than the cap.',
    keywords: ['chat', 'width', 'measure', 'readable', 'full', 'bleed', 'reading', 'column', 'layout'],
  },
  {
    id: 'theme',
    label: 'Theme',
    description: 'Choose a colour mode and visual family. Changes apply immediately.',
    keywords: ['appearance', 'colour', 'color', 'mode', 'light', 'dark', 'auto', 'family', 'palette'],
  },
  {
    id: 'dictation',
    label: 'Dictation',
    description: 'Speak into an editable message draft. Dictation never sends a message for you.',
    keywords: ['voice', 'speech', 'microphone', 'mic', 'stt', 'transcribe', 'talk', 'audio', 'parakeet'],
  },
] as const;

export const SETTINGS_DESTINATION = {
  id: 'open-settings',
  label: 'Open settings',
  description: 'Appearance, text size, theme, and dashboard density.',
  keywords: ['preferences', 'options', 'appearance', 'configure'],
} as const;

const SETTINGS_BY_ID = new Map(SETTINGS_DEFINITIONS.map(definition => [definition.id, definition]));

export function settingDefinition(id: SettingId): SettingDefinition {
  const definition = SETTINGS_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown setting: ${id}`);
  return definition;
}

export function isSettingId(value: string | null | undefined): value is SettingId {
  return Boolean(value && SETTINGS_BY_ID.has(value as SettingId));
}

export function settingsHref(id?: SettingId | null): string {
  return id ? `/settings#${id}` : '/settings';
}

export interface SettingsPaletteEntry {
  id: string;
  label: string;
  description: string;
  settingId: SettingId | null;
}

/**
 * The open command is present in the unfiltered palette. Individual controls
 * join it only when their catalog text matches the query, so "text size" and
 * "density" go straight to the relevant section without turning every Cmd+K
 * open into a second Settings page.
 */
export function settingsPaletteEntries(query: string): SettingsPaletteEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return [
      {
        id: SETTINGS_DESTINATION.id,
        label: SETTINGS_DESTINATION.label,
        description: SETTINGS_DESTINATION.description,
        settingId: null,
      },
    ];
  }

  const commandHaystack = [SETTINGS_DESTINATION.label, ...SETTINGS_DESTINATION.keywords].join(' ').toLocaleLowerCase();
  const entries: SettingsPaletteEntry[] = [];
  if (commandHaystack.includes(needle)) {
    entries.push({
      id: SETTINGS_DESTINATION.id,
      label: SETTINGS_DESTINATION.label,
      description: SETTINGS_DESTINATION.description,
      settingId: null,
    });
  }

  for (const definition of SETTINGS_DEFINITIONS) {
    const haystack = [definition.label, definition.description, ...definition.keywords].join(' ').toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    entries.push({
      id: `setting-${definition.id}`,
      label: definition.label,
      description: definition.description,
      settingId: definition.id,
    });
  }
  return entries;
}
