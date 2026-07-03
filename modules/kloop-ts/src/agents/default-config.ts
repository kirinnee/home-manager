import YAML from 'yaml';
import { flattenNestedConfig, nestFlatConfig } from '../types';
import {
  DEFAULT_IMPLEMENTER_PROMPT,
  REVIEWER_PLUMBING_PROMPT,
  REVIEW_LENS_PROFILES,
  DEFAULT_SYNTHESIZER_PROMPT,
  DEFAULT_VERIFIER_PROMPT,
  DEFAULT_RE_SYNTHESIS_PROMPT,
  CONFLICT_ONLY_CHECKPOINTER_PROMPT,
  DEFAULT_CHECKPOINTER_PROMPT,
} from './default-prompts';

// Config-file format version.
//   1 → flat layout (all keys top-level).
//   2 → nested role-block layout (pools registry + implementer/reviewer/verifier/
//       synthesizer/checkpointer blocks + settings block).
// Bumped when the layout or the explicit prompt/lens sections change so the migration
// knows to restructure + top up older config files.
export const CONFIG_VERSION = 2;

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => (line.length ? pad + line : line))
    .join('\n');
}

/** Render a `name: |` YAML block scalar with the body indented under it. */
function block(name: string, body: string, indentSpaces = 4): string {
  return `  ${name}: |\n${indent(body, indentSpaces)}`;
}

export function buildDefaultConfigYaml(): string {
  // lensProfiles live at top level, in the PROFILES section (grouped with pools).
  const lensProfiles = Object.entries(REVIEW_LENS_PROFILES)
    .map(([name, focus]) => block(name, focus))
    .join('\n');

  return `# kloop run configuration (nested v2)
#
# Account/pool specs accept trailing suffixes:
#   *  = boosted weight on loop 1 (first-iteration preferred)
#   !  = IGNORE a no-verdict (treat as pass) instead of failing
#   :harness  = explicit harness (claude|codex|gemini); guessed from first word otherwise
#
# Layout: top-level essentials, then PROFILES (reusable definitions), PER-PHASE configs
# (who runs each role), SETTINGS (behavior toggles), and PROMPTS.
configVersion: ${CONFIG_VERSION}
maxIterations: 7                  # most important knob: max implement→review loops

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║ PROFILES — reusable named definitions referenced by the per-phase configs  ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

# pools: the account registry. A pool is a named set of interchangeable accounts that
# load-balances per invocation to spread rate limits (single account = alias). Every
# role below may reference a pool BY NAME. Weights are the map values.
pools:
  claude: { claude: 1 }
# fast-codex:  { codex-auto-gpt55: 5, codex-auto-gpt54: 1 }
# claude-pair: { claude-auto-opus48: 1, claude-auto-glm52: 1 }

# lensProfiles: the "what to scrutinize" text for each review lens (the matrix rows). The
# full reviewer prompt is prompts.reviewer with the matching lens spliced in at {lensFocus}.
lensProfiles:
${lensProfiles}

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║ PER-PHASE CONFIGS — who runs each role/phase                               ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

implementer:
  # Weighted ROTATION across pools/binaries (which model writes code each loop).
  pools:
    claude: 1                     # e.g. claude*: 2  to boost a model on loop 1
  timeout: 30                     # minutes
  firstIterationWeightMultiplier: 2
  retry:
    maxRetries: 2
    backoffBaseMs: 5000           # ms, doubles each retry

reviewer:
  # Reviews run as a matrix: reviews = lenses × phase-types. Each phase is an array of
  # types run in parallel; a type is a pool name, an inline { binary: weight } pool, or a
  # bare binary. Append ! to a type to ignore its no-verdicts (e.g. flaky-codex!).
  phases:
    - - claude
  lenses:
    - general                     # add quality, completion, adherence, blindspot for the full matrix
  timeout: 15                     # minutes
  firstLoopFullReview: true
  # Retry a reviewer that produced NO parseable verdict (transport failure, crash,
  # timeout). A real approve/reject verdict is never retried.
  retry:
    maxRetries: 2
    backoffBaseMs: 5000

verifier:
  # Re-review of fixes. Types support pools (load distribution); lenses do not apply.
  phases:
    - - claude
  timeout: 5                      # minutes
  # Retry a verifier that produced NO parseable verdict (transport failure, crash,
  # timeout). A real approve/reject verdict is never retried.
  retry:
    maxRetries: 2
    backoffBaseMs: 5000

synthesizer:
  pool: claude
  timeout: 15                     # minutes
  # Retry a synthesizer that produced NO summary file (transport failure, crash,
  # timeout). Applies to both synthesis and re-synthesis.
  retry:
    maxRetries: 2
    backoffBaseMs: 5000

checkpointer:
  # Detects spec conflicts / progress. (Also the conflict checker.)
  pool: claude
  threshold: 3                    # consecutive failures before a checkpoint runs
  # Retry a checkpointer that produced NO parseable result JSON (transport failure,
  # crash, timeout). A real outcome is never retried.
  retry:
    maxRetries: 2
    backoffBaseMs: 5000

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║ SETTINGS — behavior toggles that don't belong to a single role             ║
# ╚═══════════════════════════════════════════════════════════════════════════╝
settings:
  synthesis: true
  verify: true
  rerankAfterCheckpoint: true
  previousReviewPropagation: 0.7
  compressSpec: false
  snapshot: false
  interactive: false              # run claude agents as interactive TUIs (no --print);
                                  # kloop pastes the prompt via tmux, waits for a done-marker
                                  # file the agent touches, then sends /exit. gemini/codex ignore this.
  requireUsageLeft: false         # usage-aware selection: only draw from the weighted pools
                                  # accounts that still have usage left (queried from kfleet's
                                  # /usage), and block before the implementer runs until an
                                  # exhausted pool resets. Needs "kfleet serve" running.
  # usageEndpoint: http://127.0.0.1:47318/usage  # where to fetch the usage snapshot (default)

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║ PROMPTS — full agent prompts (config is source of truth; edit freely)      ║
# ╚═══════════════════════════════════════════════════════════════════════════╝
# {placeholders} are substituted with runtime paths.
prompts:
${block('implementer', DEFAULT_IMPLEMENTER_PROMPT)}
${block('reviewer', REVIEWER_PLUMBING_PROMPT)}
${block('synthesizer', DEFAULT_SYNTHESIZER_PROMPT)}
${block('verifier', DEFAULT_VERIFIER_PROMPT)}
${block('reSynthesizer', DEFAULT_RE_SYNTHESIS_PROMPT)}
${block('checkpointer', CONFLICT_ONLY_CHECKPOINTER_PROMPT)}
${block('checkpointerFull', DEFAULT_CHECKPOINTER_PROMPT)}
`;
}

/**
 * Upgrade a raw config object to CONFIG_VERSION. Two things happen for a pre-v2 file:
 *   1. Additive top-up: fills MISSING explicit sections (reviewLenses, lensProfiles,
 *      prompts, and missing per-prompt keys) from the current defaults, but NEVER
 *      overwrites a section/key the user already set ("config is source of truth").
 *   2. Restructure: rewrites the flat layout into the nested role-block layout (v2).
 * The top-up runs in FLAT space (where pre-v2 keys live), then the result is re-nested.
 * Returns the possibly-rewritten object and whether anything changed.
 */
export function migrateConfigObject(raw: unknown): { config: Record<string, unknown>; changed: boolean } {
  const cfg: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  const current = typeof cfg.configVersion === 'number' ? cfg.configVersion : 0;
  if (current >= CONFIG_VERSION) return { config: cfg, changed: false };

  // Work in flat space so a flat v1 (or a partial/hybrid) config is normalized uniformly.
  const flat = flattenNestedConfig(cfg) as Record<string, unknown>;
  const defaultsFlat = flattenNestedConfig(YAML.parse(buildDefaultConfigYaml())) as Record<string, unknown>;

  // Resolve legacy back-compat ALIASES into modern flat keys BEFORE nesting — nestFlatConfig
  // only emits modern keys, so an un-resolved alias would be silently dropped on persist.
  //   reviewers (flat array)      → reviewPhases
  //   reReview { enabled,phases,timeout } → verify / verifyPhases / verifyTimeout
  //   synthesis { enabled }       → synthesis (boolean)
  if (flat.reviewPhases === undefined && Array.isArray(flat.reviewers) && flat.reviewers.length > 0) {
    flat.reviewPhases = [flat.reviewers];
  }
  delete flat.reviewers;
  if (flat.reReview && typeof flat.reReview === 'object') {
    const rr = flat.reReview as Record<string, unknown>;
    if (flat.verify === undefined && rr.enabled !== undefined) flat.verify = rr.enabled;
    if (flat.verifyPhases === undefined && rr.phases !== undefined) flat.verifyPhases = rr.phases;
    if (flat.verifyTimeout === undefined && rr.timeout !== undefined) flat.verifyTimeout = rr.timeout;
  }
  delete flat.reReview;
  if (flat.synthesis && typeof flat.synthesis === 'object') {
    flat.synthesis = (flat.synthesis as Record<string, unknown>).enabled ?? true;
  }
  // Singular legacy `implementer` (string) → merge into `implementers` (mirrors the schema
  // transform). nestFlatConfig prefers `implementers`, so the both-present case would
  // otherwise drop the singular entry.
  if (typeof flat.implementer === 'string') {
    const impl =
      flat.implementers && typeof flat.implementers === 'object'
        ? { ...(flat.implementers as Record<string, number>) }
        : {};
    if (!(flat.implementer in impl)) impl[flat.implementer] = 1;
    flat.implementers = impl;
    delete flat.implementer;
  }
  // `prompts.reReviewer` is a legacy alias for `prompts.verifier`. Resolve it BEFORE the
  // prompt top-up injects a default `verifier` (which would otherwise permanently shadow
  // the user's custom re-reviewer prompt via the schema's `verifier ?? reReviewer`).
  if (flat.prompts && typeof flat.prompts === 'object') {
    const pr = { ...(flat.prompts as Record<string, unknown>) };
    if (pr.reReviewer !== undefined) {
      if (pr.verifier === undefined) pr.verifier = pr.reReviewer;
      delete pr.reReviewer; // dead alias — verifier wins; don't persist it to the v2 file
      flat.prompts = pr;
    }
  }

  for (const key of ['reviewLenses', 'lensProfiles', 'prompts'] as const) {
    if (flat[key] === undefined) flat[key] = defaultsFlat[key];
  }
  // Add only MISSING prompt keys; keep any the user already customized. Clone the
  // nested prompts object first so we never mutate the caller's input.
  if (
    flat.prompts &&
    typeof flat.prompts === 'object' &&
    defaultsFlat.prompts &&
    typeof defaultsFlat.prompts === 'object'
  ) {
    const userPrompts = { ...(flat.prompts as Record<string, unknown>) };
    const defPrompts = defaultsFlat.prompts as Record<string, unknown>;
    for (const k of Object.keys(defPrompts)) {
      if (userPrompts[k] === undefined) userPrompts[k] = defPrompts[k];
    }
    flat.prompts = userPrompts;
  }

  flat.configVersion = CONFIG_VERSION;
  // Restructure flat → nested role-block layout for the on-disk file.
  const nested = nestFlatConfig(flat);
  return { config: nested, changed: true };
}

/**
 * Migrate a config YAML string. Returns the (possibly rewritten) YAML text and whether
 * it changed. Re-serializes via YAML when a migration was applied (comments are dropped,
 * but the explicit prompt/lens config is preserved).
 */
export function migrateConfigYamlText(text: string): { text: string; changed: boolean } {
  const raw = YAML.parse(text) ?? {};
  const { config, changed } = migrateConfigObject(raw);
  return { text: changed ? YAML.stringify(config) : text, changed };
}
