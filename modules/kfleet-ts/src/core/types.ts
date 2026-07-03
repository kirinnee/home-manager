// The kfleet config schema. Everything composes from profiles.
//
// A wrapper is generated for every (agent × variant). Its fields are merged:
//   base -> agent.profiles -> variant.profiles -> variant.inline -> agent.inline
// (right overrides left). Merge rules (see core/merge.ts):
//   env             -> objects merge (later keys win)
//   flags, settings -> layers concatenate (settings deep-merge at materialize)
//   others          -> scalars replace (last writer wins)
//
// The `default` variant produces `<kind>-<name>`; any other variant V produces
// `<kind>-V-<name>` (e.g. the `auto` variant → `claude-auto-kirin`).
import { z } from 'zod';

const KINDS = ['claude', 'codex'] as const;
const kindSchema = z.enum(KINDS);
export type Kind = (typeof KINDS)[number];

// A settings layer is either a path to a base config file or an inline object of
// override values. Multiple layers deep-merge left→right (later wins) into one
// destination file, parsed/serialized per kind (codex:TOML claude:JSON). A lone
// file-path layer is copied/symlinked verbatim (no parse → comments preserved).
const settingsLayerSchema = z.union([z.string(), z.record(z.unknown())]);
export type SettingsLayer = z.infer<typeof settingsLayerSchema>;

// Asset references are paths relative to ~/.kfleet (or ~/… / absolute). The
// per-kind generator decides the destination filename inside the config dir.
const baseProfileFields = {
  env: z.record(z.string()).optional(),
  flags: z.array(z.string()).optional(),
  // settings is layered: a file path, an inline override object, or a (non-empty)
  // list of either. Layers accumulate across the merge chain (like flags) and
  // deep-merge at materialization. claude:settings.json codex:config.toml
  settings: z.union([settingsLayerSchema, z.array(settingsLayerSchema).min(1)]).optional(),
  memory: z.string().optional(), // claude:CLAUDE.md codex:AGENTS.md
  skills: z.string().optional(), // skills/ dir (claude)
  hooks: z.string().optional(), // codex hooks.json (claude bakes hooks into settings)
  hooksDir: z.string().optional(), // hooks/ dir of shell scripts
  mcp: z.string().optional(), // mcp servers json
};

const baseProfileSchema = z.object(baseProfileFields).strict();
export type Profile = z.infer<typeof baseProfileSchema>;

// Kind-scoped overlay. A profile/variant/agent may carry per-kind sub-profiles
// (`claude:` / `codex:`) that merge in ONLY for an agent of that kind, then are
// dropped. One level deep — a sub-profile can't itself nest kind blocks. This is
// how a cross-kind variant can still vary a per-kind asset: e.g. the `auto`
// variant can hand codex's auto wrappers a different config.toml (or flags)
// without that override leaking onto claude's auto wrappers. Merged in the same
// chain slot as the block it sits in (see core/merge.ts).
const profileFields = {
  ...baseProfileFields,
  claude: baseProfileSchema.optional(),
  codex: baseProfileSchema.optional(),
};

const profileSchema = z.object(profileFields).strict();
export type ScopedProfile = z.infer<typeof profileSchema>;

const agentSchema = z
  .object({
    name: z.string().min(1),
    kind: kindSchema,
    profiles: z.array(z.string()).optional(),
    ...profileFields,
  })
  .strict();

// A command is a thin generated executable that execs an existing agent's wrapper
// with flags prepended — e.g. `yolo-kirin` -> `claude-kirin --dangerously-skip-permissions`.
// Real binaries on PATH (not shell aliases), so scripts/tools can call them too.
const commandSchema = z
  .object({
    name: z.string().min(1), // the generated command name (and wrapper filename)
    target: z.string().min(1), // an agent wrapper name, e.g. "claude-kirin"
    flags: z.array(z.string()).default([]), // prepended before the user's args
  })
  .strict();
export type CommandDef = z.infer<typeof commandSchema>;

// An alias is ONE entry that fans out into a command for every agent of the
// listed kind(s): `yolo: { claude: "--dangerously-skip-permissions" }` generates
// `yolo-claude-<name>` for every claude agent×variant. Flags are per-kind because
// each harness has different ones (claude --dangerously-skip-permissions, codex
// --full-auto, …); a kind you don't list simply gets no alias wrapper. Flags may
// be a whitespace-separated string or an array.
const aliasFlags = z.union([z.string(), z.array(z.string())]);
const aliasSchema = z.record(z.string(), aliasFlags); // kind -> flags (partial)
const aliasesSchema = z.record(z.string(), aliasSchema); // alias name -> per-kind flags
export type AliasMap = z.infer<typeof aliasesSchema>;

// Optional mapping from each kind's default CLI home to one resolved agent.
// Values may be either the resolved agent name (`kirin`, `personal`) or the full
// wrapper name (`claude-kirin`, `codex-personal`).
const defaultHomesSchema = z
  .object({
    claude: z.string().min(1).optional(),
    codex: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export type DefaultHomeMap = z.infer<typeof defaultHomesSchema>;

// Fleet health probing (`kfleet health` / the `kfleet serve` background loop).
// `enabled` is OFF by default: each probe is a real LLM call, so the background
// loop in `serve`/the service does nothing until you opt in. `kfleet health`
// (the explicit one-shot) always runs regardless. interval/concurrency/timeout
// tune the background loop and supply the CLI defaults.
const healthSchema = z
  .object({
    enabled: z.boolean().default(false),
    interval: z.number().default(300), // seconds between background re-probes
    concurrency: z.number().default(8), // how many agents probed at once
    timeout: z.number().default(90), // seconds per probe before it's "down"
  })
  .default({});

// Account usage/quota probing (`kfleet usage` / the `kfleet serve` background loop).
// Unlike health, a usage probe is a cheap READ-ONLY HTTP call to each provider's
// usage endpoint (it does NOT consume any quota), so it's safe to run on a short
// interval and is ON by default. Only subscription/windowed accounts are probed:
// Anthropic OAuth (Max/Pro), Codex (ChatGPT), z.ai GLM + MiniMax coding plans —
// every other account reports usage_based=0 and is left alone. `atLimitPercent` is
// the 5h-OR-weekly utilization at/above which an account counts as exhausted.
// `interval` is jittered by ±`jitter` each cycle so a fleet's probes don't sync up.
// `relogin` (default ON) first runs a token-free wrapper invocation on any OAuth
// account whose access token is expired, so the CLI refreshes it before we probe.
const usageSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.number().min(1).default(60), // seconds between background re-probes (before jitter)
    jitter: z.number().min(0).max(1).default(0.25), // ± fraction of interval added as random jitter
    concurrency: z.number().min(1).default(6), // how many credentials probed at once
    timeout: z.number().min(1).default(15), // seconds per HTTP probe before it's an error
    atLimitPercent: z.number().min(1).max(100).default(100), // 5h OR weekly ≥ this ⇒ at limit
    relogin: z.boolean().default(true), // pre-probe token-free re-login for expired OAuth accounts
  })
  .default({});

// A variant is a profile-composition cloned across every agent. `profiles` are
// overlaid after the agent's own profiles; inline fields override those but lose
// to the agent's own inline fields. The `default` variant is always present
// (injected if absent) and adds no name infix.
const variantSchema = z
  .object({
    profiles: z.array(z.string()).optional(),
    ...profileFields,
  })
  .strict();
export type Variant = z.infer<typeof variantSchema>;

export const configSchema = z
  .object({
    profiles: z.record(profileSchema).default({}),
    variants: z.record(variantSchema).default({ default: {} }),
    agents: z.array(agentSchema).default([]),
    commands: z.array(commandSchema).default([]),
    aliases: aliasesSchema.default({}),
    defaultHomes: defaultHomesSchema,
    health: healthSchema,
    usage: usageSchema,
  })
  .strict();
export type Config = z.infer<typeof configSchema>;

/** An agent with base + profiles fully merged down into one flat profile.
 *  `settings` is normalized to an ordered list of layers (see core/merge.ts). */
export type ResolvedAgent = { name: string; kind: Kind } & Omit<Profile, 'settings'> & {
    settings?: SettingsLayer[];
  };
