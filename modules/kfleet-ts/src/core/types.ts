// The kfleet config schema. Everything composes from profiles.
//
// A wrapper is generated for every (agent × variant). Its fields are merged:
//   base -> agent.profiles -> variant.profiles -> variant.inline -> agent.inline
// (right overrides left). Merge rules (see core/merge.ts):
//   env    -> objects merge (later keys win)
//   flags  -> arrays concatenate
//   others -> scalars replace (last writer wins)
//
// The `default` variant produces `<kind>-<name>`; any other variant V produces
// `<kind>-V-<name>` (e.g. the `auto` variant → `claude-auto-kirin`).
import { z } from 'zod';

const KINDS = ['claude', 'codex'] as const;
const kindSchema = z.enum(KINDS);
export type Kind = (typeof KINDS)[number];

// Asset references are paths relative to ~/.kfleet (or ~/… / absolute). The
// per-kind generator decides the destination filename inside the config dir.
// `settings` is per-kind (claude:settings.json codex:config.toml) so keep it on a
// per-kind profile/agent, not a cross-kind variant.
const profileFields = {
  env: z.record(z.string()).optional(),
  flags: z.array(z.string()).optional(),
  settings: z.string().optional(),
  memory: z.string().optional(), // claude:CLAUDE.md codex:AGENTS.md
  skills: z.string().optional(), // skills/ dir (claude)
  hooks: z.string().optional(), // codex hooks.json (claude bakes hooks into settings)
  hooksDir: z.string().optional(), // hooks/ dir of shell scripts
  mcp: z.string().optional(), // mcp servers json
};

const profileSchema = z.object(profileFields).strict();
export type Profile = z.infer<typeof profileSchema>;

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
export type HealthConfig = z.infer<typeof healthSchema>;

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
    health: healthSchema,
  })
  .strict();
export type Config = z.infer<typeof configSchema>;

/** An agent with base + profiles fully merged down into one flat profile. */
export type ResolvedAgent = { name: string; kind: Kind } & Profile;
