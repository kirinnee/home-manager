// SETTINGS CATALOG — one declarative source for the Settings surface and the
// command palette. Labels, descriptions, anchors and search terms live here so
// adding a setting cannot silently make its palette entry drift from the UI.

export type SettingId = 'text-size' | 'density' | 'theme' | 'chat-width' | 'dictation' | 'notifications';

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
    label: 'Conversation width',
    description:
      'Full-bleed is the default. Choose whether a wide conversation uses the available pane or is capped at 768px and centred; narrower panes look the same in either mode.',
    keywords: [
      'chat',
      'conversation',
      'width',
      'measure',
      'readable',
      'full',
      'full pane',
      'full-bleed',
      'bleed',
      'reading',
      'column',
      'layout',
    ],
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
    description:
      'Speak into an editable message draft. Dictation never sends a message for you. Includes enhancement: a dictionary and context that fix misheard names and jargon.',
    keywords: [
      'voice',
      'speech',
      'microphone',
      'mic',
      'stt',
      'transcribe',
      'transcription',
      'talk',
      'push to talk',
      'shortcut',
      'hotkey',
      'alt',
      'audio',
      'parakeet',
      // The enhancement feature lives inside this section; without its own
      // names here, searching the palette for it by name found nothing.
      'enhance',
      'enhancement',
      'dictionary',
      'vocabulary',
      'glossary',
      'jargon',
      'correction',
      'corrections',
      'words',
      'names',
      'context',
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description:
      'System notification when a session needs attention — waiting at the prompt, asking a question, failed, or finished. Off by default; turning it on asks the browser for permission.',
    keywords: [
      'notify',
      'notification',
      'alert',
      'push',
      'buzz',
      'awaiting',
      'needs attention',
      'question',
      'background',
    ],
  },
] as const;

export const SETTINGS_DESTINATION = {
  id: 'open-settings',
  label: 'Open settings',
  description: 'Appearance, text size, conversation width, theme, and dashboard density.',
  keywords: ['preferences', 'options', 'appearance', 'configure'],
} as const;

/** Link rows: settings that LIVE elsewhere but must be findable from the
 *  Settings page and the palette. Unlike SETTINGS_DEFINITIONS (per-browser
 *  localStorage preferences), these point at daemon-global, admin-token
 *  server state — rendering them as links keeps this page's client-local
 *  contract honest while honoring "it's in settings" muscle memory. */
export interface SettingsLinkDefinition {
  id: string;
  label: string;
  description: string;
  href: string;
  keywords: readonly string[];
}

export const SETTINGS_LINKS: readonly SettingsLinkDefinition[] = [
  {
    id: 'warden',
    label: 'Warden & failover',
    description:
      'Configure warden accounts and the failover policy (fallback or round-robin), and see which account is active. Daemon-wide — lives on the Warden page.',
    href: '/warden#config',
    keywords: ['warden', 'failover', 'round robin', 'fallback', 'account', 'quota', 'token', 'wrapper', 'supervision'],
  },
] as const;

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
  /** Link rows navigate here instead of a Settings section (e.g. /warden#config). */
  href?: string;
}

export interface SettingsPaletteContext {
  /** Current browser-local binding, supplied by the palette without making
   * this general settings catalog own dictation storage. */
  dictationShortcutLabel?: string;
}

/**
 * The open command is present in the unfiltered palette. Individual controls
 * join it only when their catalog text matches the query, so "text size" and
 * "density" go straight to the relevant section without turning every Cmd+K
 * open into a second Settings page.
 */
export function settingsPaletteEntries(query: string, context: SettingsPaletteContext = {}): SettingsPaletteEntry[] {
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
    const description =
      definition.id === 'dictation' && context.dictationShortcutLabel
        ? `${definition.description} Push-to-talk shortcut: ${context.dictationShortcutLabel}.`
        : definition.description;
    const haystack = [definition.label, description, ...definition.keywords].join(' ').toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    entries.push({
      id: `setting-${definition.id}`,
      label: definition.label,
      description,
      settingId: definition.id,
    });
  }
  // Link rows ride the same query so "failover" / "round robin" in Cmd/Ctrl+K
  // jumps straight to the Warden config card.
  for (const link of SETTINGS_LINKS) {
    const haystack = [link.label, link.description, ...link.keywords].join(' ').toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    entries.push({
      id: `setting-link-${link.id}`,
      label: link.label,
      description: link.description,
      settingId: null,
      href: link.href,
    });
  }
  return entries;
}
