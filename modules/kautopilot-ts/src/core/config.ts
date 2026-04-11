import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as YAML from 'yaml';
import type { Config } from './types';
import { DEFAULT_CONFIG } from './types';

// ============================================================================
// Variable descriptions for generated config comments
// ============================================================================

const PROMPT_VARS: Record<string, Record<string, string>> = {
  'agents.init.localInit': {
    sessionId: 'the kautopilot session ID',
  },
  'agents.init.researchTicketSystem': {
    taskSystem: 'the ticket system name (e.g., "jira", "linear", "clickup")',
    detectedInfo: 'detected CLI tools on the system',
  },
  'agents.init.researchSetup': {
    taskSystem: 'the ticket system name',
    accessMethod: 'user-provided access hint',
  },
  'agents.init.createScripts': {
    taskSystem: 'the ticket system name',
    accessMethod: 'the chosen access method',
    stateMapping: 'JSON mapping of ticket states',
    transitionNoOp: 'comment if a transition is a no-op',
    branch: 'current git branch name',
    scriptsDir: 'path to the scripts directory',
    quirks: 'any system-specific quirks',
    setupAssessment: 'result of setup assessment',
    researchDoc: 'the research document content',
    detectedInfo: 'detected CLI tools',
    scriptList: 'required scripts to create',
    optionalScripts: 'optional scripts to create',
  },
  'agents.phase1.triage': {
    ticket: 'path to the ticket file',
  },
  'agents.phase1.spec_writer': {
    ticket: 'path to the ticket file',
    triage: 'path to the triage file',
  },
  'agents.phase1.plan_writer': {
    spec: 'path to the spec file',
    triage: 'path to the triage file',
  },
  'agents.phase1.spec_reviewers.*': {
    spec: 'path to the spec file',
    ticket: 'path to the ticket file',
    triage: 'path to the triage file (for verification_evidence reviewer)',
  },
  'agents.phase1.plan_reviewers.*': {
    plans: 'path to the plans directory',
    spec: 'path to the spec file',
  },
  'agents.phase2.resolve': {
    plan: 'name of the current plan (e.g., "plan-1")',
    spec: 'path to the current plan file',
    taskSpec: 'path to the task spec file',
    reason: 'reason for resolve ("conflict" or "retry")',
    attempt: 'attempt number (1-indexed)',
  },
  'agents.phase2.amend_plans': {
    resolution_path: 'path to the resolution document written by resolve TTY',
    task_spec_path: 'path to the task spec file',
    plans_dir: 'path to the plans directory',
    kloop_evidence: 'output from kloop describe',
  },
  'agents.phase3.eval': {
    spec_path: 'path to the task spec file',
    plan_paths: 'paths to plan files (newline-separated)',
  },
  'agents.phase3.write_fix': {
    // Context prepended by handler, not user-configurable
  },
  'agents.phase3.create_pr': {
    baseBranch: 'the base branch name (e.g., "main")',
    ticketId: 'the ticket ID',
    spec_path: 'path to the spec file',
  },
  'agents.phase3.prereview_classify': {
    // Content prepended by handler
  },
  'agents.phase3.prereview_fix': {
    // Content prepended by handler
  },
  'agents.phase3.tty_resolve_ambiguous': {
    // Context prepended by handler
  },
  'agents.phase3.tty_resolve_conflict': {
    // Context prepended by handler
  },
  'agents.phase3.tty_resolve_failure': {
    // Context prepended by handler
  },
  'agents.generic.commit': {
    context: 'optional context (e.g., plan path, reason for commit)',
  },
};

/**
 * Build variable comment lines for a prompt path.
 * Returns empty string if no variables defined.
 */
function buildVarComments(path: string): string {
  const vars = PROMPT_VARS[path];
  if (!vars || Object.keys(vars).length === 0) return '';
  const lines = Object.entries(vars)
    .map(([v, desc]) => `# {${v}} - ${desc}`)
    .join('\n');
  return `${lines}\n`;
}

/**
 * Kloop prompt variable descriptions.
 */
const KLOOP_PROMPT_VARS: Record<string, Record<string, string>> = {
  implementer: {
    specPath: 'path to the spec file',
    iteration: 'current loop number',
    reviewsDir: "path to previous loop's reviews/ folder (empty for loop 1)",
    evidenceDir: 'path to evidence/ folder',
    learningsFile: 'path to learnings.md',
  },
  reviewer: {
    specPath: 'path to the spec file',
    iteration: 'current loop number',
    reviewerIndex: 'which reviewer this is',
    reviewsDir: 'path to reviews/ folder (write review .md here)',
    verdictsDir: 'path to verdicts/ folder (write verdict .json here)',
    evidenceDir: 'path to evidence/ folder',
    learningsFile: 'path to learnings.md',
    archivedReviews: 'conditional block for previous loop reviews',
  },
  checkpointer: {
    specPath: 'path to the spec file',
    iteration: 'current loop number',
    reviewsDir: "path to current loop's reviews/",
    archivedReviewsPattern: 'glob pattern for all previous loop reviews',
    conflictFile: 'path to run-level conflict.md',
    checkpointResultFile: 'path to checkpoint-result.json',
  },
  checkpointerFull: {
    specPath: 'path to the spec file',
    iteration: 'current loop number',
    reviewsDir: "path to current loop's reviews/",
    archivedReviewsPattern: 'glob pattern for all previous loop reviews',
    conflictFile: 'path to run-level conflict.md',
    checkpointResultFile: 'path to checkpoint-result.json',
    specBackupFile: 'path to spec-backup.md (used during compression)',
  },
};

/**
 * Serialize config to YAML with variable comments for prompts.
 * This ensures users know what variables are available.
 */
export function serializeConfigWithComments(config: Config): string {
  const lines: string[] = ['# kautopilot global config', '# Edit these to customize agent behavior and binary.', ''];

  // Claude binary (single line)
  lines.push(`claude_binary: ${config.claude_binary}`);
  lines.push('');

  // Agents section
  lines.push('agents:');
  for (const [phaseKey, phaseAgents] of Object.entries(config.agents)) {
    lines.push(`  ${phaseKey}:`);
    if (phaseKey === 'phase1') {
      const p1 = phaseAgents as Config['agents']['phase1'];
      // triage, spec_writer, plan_writer
      for (const agent of ['triage', 'spec_writer', 'plan_writer'] as const) {
        const path = `agents.phase1.${agent}`;
        lines.push(`    ${agent}:`);
        lines.push(createPromptBlock(path, (p1[agent] as { prompt: string }).prompt, 6));
      }
      // spec_reviewers
      lines.push('    spec_reviewers:');
      for (const [name, reviewer] of Object.entries(p1.spec_reviewers)) {
        const path = 'agents.phase1.spec_reviewers.*';
        lines.push(`      ${name}:`);
        lines.push(`        desc: ${JSON.stringify(reviewer.desc)}`);
        const varComments = buildVarComments(path);
        // Variable comments go BEFORE prompt: as YAML comments
        if (varComments) {
          lines.push(indentLines(varComments.trimEnd(), 8));
        }
        lines.push(`        prompt: |`);
        lines.push(indentLines(reviewer.prompt, 10));
      }
      // plan_reviewers
      lines.push('    plan_reviewers:');
      for (const [name, reviewer] of Object.entries(p1.plan_reviewers)) {
        const path = 'agents.phase1.plan_reviewers.*';
        lines.push(`      ${name}:`);
        lines.push(`        desc: ${JSON.stringify(reviewer.desc)}`);
        const varComments = buildVarComments(path);
        // Variable comments go BEFORE prompt: as YAML comments
        if (varComments) {
          lines.push(indentLines(varComments.trimEnd(), 8));
        }
        lines.push(`        prompt: |`);
        lines.push(indentLines(reviewer.prompt, 10));
      }
    } else if (phaseKey === 'phase2' || phaseKey === 'phase3') {
      for (const [agentName, agentConfig] of Object.entries(phaseAgents as Record<string, { prompt: string }>) as [
        string,
        { prompt: string },
      ][]) {
        const path = `agents.${phaseKey}.${agentName}`;
        lines.push(`    ${agentName}:`);
        lines.push(createPromptBlock(path, agentConfig.prompt, 6));
      }
    } else if (phaseKey === 'init') {
      for (const [agentName, agentConfig] of Object.entries(phaseAgents as Record<string, { prompt: string }>) as [
        string,
        { prompt: string },
      ][]) {
        const path = `agents.init.${agentName}`;
        lines.push(`    ${agentName}:`);
        lines.push(createPromptBlock(path, agentConfig.prompt, 6));
      }
    } else if (phaseKey === 'generic') {
      const genericAgents = phaseAgents as Config['agents']['generic'];
      for (const [agentName, agentConfig] of Object.entries(genericAgents) as [string, { prompt: string }][]) {
        const path = `agents.generic.${agentName}`;
        lines.push(`    ${agentName}:`);
        lines.push(createPromptBlock(path, agentConfig.prompt, 6));
      }
    }
  }
  lines.push('');

  // Templates section
  lines.push('templates:');
  for (const [key, value] of Object.entries(config.templates)) {
    lines.push(`  ${key}: |`);
    lines.push(indentLines(value, 4));
  }
  lines.push('');

  // Kloop section
  lines.push('kloop:');
  lines.push(`  implementers:`);
  for (const [k, v] of Object.entries(config.kloop.implementers)) {
    lines.push(`    ${k}: ${v}`);
  }
  lines.push(`  reviewPhases:`);
  for (const phase of config.kloop.reviewPhases) {
    lines.push(`    - [${phase.join(', ')}]`);
  }
  if (config.kloop.conflictChecker) {
    lines.push(`  conflictChecker: ${config.kloop.conflictChecker}`);
  }
  lines.push(`  maxIterations: ${config.kloop.maxIterations}`);
  lines.push(`  implementerTimeout: ${config.kloop.implementerTimeout}`);
  lines.push(`  reviewerTimeout: ${config.kloop.reviewerTimeout}`);
  lines.push(`  conflictCheckThreshold: ${config.kloop.conflictCheckThreshold}`);
  lines.push(`  compressSpec: ${config.kloop.compressSpec}`);
  lines.push(`  firstLoopFullReview: ${config.kloop.firstLoopFullReview}`);
  lines.push(`  previousReviewPropagation: ${config.kloop.previousReviewPropagation}`);
  // Kloop prompts section — uses raw string values, not nested objects
  if (config.kloop.prompts) {
    lines.push('  prompts:');
    for (const [name, prompt] of Object.entries(config.kloop.prompts)) {
      if (prompt) {
        const vars = KLOOP_PROMPT_VARS[name];
        // Variable comments go BEFORE the key (as regular YAML comments)
        if (vars) {
          for (const [v, desc] of Object.entries(vars)) {
            lines.push(`    # {${v}} - ${desc}`);
          }
        }
        lines.push(`    ${name}: |`);
        lines.push(indentLines(prompt, 6));
      }
    }
  }
  lines.push('');

  // Settings section
  lines.push('settings:');
  lines.push(`  maxPushCycles: ${config.settings.maxPushCycles}`);
  lines.push(`  pollInterval: ${config.settings.pollInterval}`);
  lines.push(`  defaultLlmTimeout: ${config.settings.defaultLlmTimeout}`);
  lines.push(`  coderabbit: ${config.settings.coderabbit}`);
  lines.push(`  removeSpecOnPush: ${config.settings.removeSpecOnPush}`);
  lines.push('');

  // Repo section
  lines.push('repo:');
  if (config.repo.org) lines.push(`  org: ${config.repo.org}`);
  lines.push(`  baseBranch: ${config.repo.baseBranch}`);
  lines.push(`  ticketSystem: ${config.repo.ticketSystem ?? 'null'}`);
  lines.push(`  prComment: ${config.repo.prComment ?? 'null'}`);

  return `${lines.join('\n')}\n`;
}

/**
 * Create a prompt block with variable comments as YAML comments before the prompt key.
 * @param path - the agent path for looking up variable descriptions
 * @param prompt - the prompt content
 * @param indentSpaces - how many spaces to indent the entire block
 */
function createPromptBlock(path: string, prompt: string, indentSpaces: number): string {
  const varComments = buildVarComments(path);
  const indent = ' '.repeat(indentSpaces);
  const indentedPrompt = indentLines(prompt, indentSpaces + 2);

  // Variable comments go BEFORE prompt: as YAML comments
  if (varComments) {
    const indentedComments = indentLines(varComments.trimEnd(), indentSpaces);
    return `${indentedComments}\n${indent}prompt: |\n${indentedPrompt}`;
  }
  return `${indent}prompt: |\n${indentedPrompt}`;
}

function indentLines(text: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => indent + line)
    .join('\n');
}

function configPath(id: string): string {
  return `${process.env.HOME}/.kautopilot/${id}/config.yaml`;
}

export function readConfig(id: string): Config | null {
  const path = configPath(id);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = YAML.parse(raw) as Partial<Config> | undefined;
  if (!parsed) return DEFAULT_CONFIG;
  // Legacy migration: hoist old settings fields into kloop
  const legacySettings = parsed.settings as Record<string, unknown> | undefined;
  const migratedKloop = { ...(parsed.kloop ?? {}) } as Record<string, unknown>;
  if (legacySettings) {
    if (migratedKloop.maxIterations == null && legacySettings.maxIterations != null)
      migratedKloop.maxIterations = legacySettings.maxIterations;
    if (migratedKloop.implementerTimeout == null && legacySettings.implementerTimeout != null)
      migratedKloop.implementerTimeout = legacySettings.implementerTimeout;
    if (migratedKloop.reviewerTimeout == null && legacySettings.reviewerTimeout != null)
      migratedKloop.reviewerTimeout = legacySettings.reviewerTimeout;
  }

  return {
    claude_binary: parsed.claude_binary ?? DEFAULT_CONFIG.claude_binary,
    agents: {
      init: { ...DEFAULT_CONFIG.agents.init, ...parsed.agents?.init },
      phase1: {
        triage: {
          ...DEFAULT_CONFIG.agents.phase1.triage,
          ...parsed.agents?.phase1?.triage,
        },
        spec_writer: {
          ...DEFAULT_CONFIG.agents.phase1.spec_writer,
          ...parsed.agents?.phase1?.spec_writer,
        },
        plan_writer: {
          ...DEFAULT_CONFIG.agents.phase1.plan_writer,
          ...parsed.agents?.phase1?.plan_writer,
        },
        spec_reviewers: {
          ...DEFAULT_CONFIG.agents.phase1.spec_reviewers,
          ...parsed.agents?.phase1?.spec_reviewers,
        },
        plan_reviewers: {
          ...DEFAULT_CONFIG.agents.phase1.plan_reviewers,
          ...parsed.agents?.phase1?.plan_reviewers,
        },
      },
      phase2: { ...DEFAULT_CONFIG.agents.phase2, ...parsed.agents?.phase2 },
      phase3: { ...DEFAULT_CONFIG.agents.phase3, ...parsed.agents?.phase3 },
      generic: { ...DEFAULT_CONFIG.agents.generic, ...parsed.agents?.generic },
    },
    templates: { ...DEFAULT_CONFIG.templates, ...parsed.templates },
    kloop: {
      ...DEFAULT_CONFIG.kloop,
      ...migratedKloop,
      // Deep merge prompts
      prompts: {
        ...DEFAULT_CONFIG.kloop.prompts,
        ...(migratedKloop.prompts as Record<string, string> | undefined),
      },
    },
    settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
    repo: { ...DEFAULT_CONFIG.repo, ...parsed.repo },
  };
}

export function writeConfig(id: string, config: Config): void {
  const path = configPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(config));
}

// ============================================================================
// Config resolution (init-time)
// ============================================================================

function globalConfigPath(): string {
  return `${process.env.HOME}/.kautopilot/config.yaml`;
}

function orgConfigPath(org: string): string {
  return `${process.env.HOME}/.kautopilot/orgs/${org}/config.yaml`;
}

export function resolvedConfigPath(org?: string, configPathOverride?: string): string | null {
  return pickConfig(org, configPathOverride);
}

/**
 * Ensure ~/.kautopilot/config.yaml exists with built-in defaults.
 * Called on first init or org init.
 */
export function ensureGlobalConfig(): void {
  const path = globalConfigPath();
  if (existsSync(path)) return;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeConfigWithComments(DEFAULT_CONFIG));
}

/**
 * Pick which config file to use (only one wins, not merged).
 * Priority: --config flag > org config > global config
 */
export function pickConfig(org?: string, configPathOverride?: string): string | null {
  if (configPathOverride) return configPathOverride;
  if (org) {
    const orgPath = orgConfigPath(org);
    if (existsSync(orgPath)) return orgPath;
  }
  return globalConfigPath();
}

/**
 * Resolve final config: merge built-in defaults with the picked config file.
 * One config file wins — no multi-layer merging at init time.
 */
export function resolveConfig(org?: string, configPathOverride?: string): Config {
  const picked = pickConfig(org, configPathOverride);
  if (!picked || !existsSync(picked)) return { ...DEFAULT_CONFIG };

  const raw = readFileSync(picked, 'utf-8');
  const parsed = YAML.parse(raw) as Partial<Config> | undefined;
  if (!parsed) return { ...DEFAULT_CONFIG };

  // Legacy migration: hoist old settings fields into kloop
  const legacySettings = parsed.settings as Record<string, unknown> | undefined;
  const migratedKloop = { ...(parsed.kloop ?? {}) } as Record<string, unknown>;
  if (legacySettings) {
    if (migratedKloop.maxIterations == null && legacySettings.maxIterations != null)
      migratedKloop.maxIterations = legacySettings.maxIterations;
    if (migratedKloop.implementerTimeout == null && legacySettings.implementerTimeout != null)
      migratedKloop.implementerTimeout = legacySettings.implementerTimeout;
    if (migratedKloop.reviewerTimeout == null && legacySettings.reviewerTimeout != null)
      migratedKloop.reviewerTimeout = legacySettings.reviewerTimeout;
  }

  return {
    claude_binary: parsed.claude_binary ?? DEFAULT_CONFIG.claude_binary,
    agents: {
      init: { ...DEFAULT_CONFIG.agents.init, ...parsed.agents?.init },
      phase1: {
        triage: {
          ...DEFAULT_CONFIG.agents.phase1.triage,
          ...parsed.agents?.phase1?.triage,
        },
        spec_writer: {
          ...DEFAULT_CONFIG.agents.phase1.spec_writer,
          ...parsed.agents?.phase1?.spec_writer,
        },
        plan_writer: {
          ...DEFAULT_CONFIG.agents.phase1.plan_writer,
          ...parsed.agents?.phase1?.plan_writer,
        },
        spec_reviewers: {
          ...DEFAULT_CONFIG.agents.phase1.spec_reviewers,
          ...parsed.agents?.phase1?.spec_reviewers,
        },
        plan_reviewers: {
          ...DEFAULT_CONFIG.agents.phase1.plan_reviewers,
          ...parsed.agents?.phase1?.plan_reviewers,
        },
      },
      phase2: { ...DEFAULT_CONFIG.agents.phase2, ...parsed.agents?.phase2 },
      phase3: { ...DEFAULT_CONFIG.agents.phase3, ...parsed.agents?.phase3 },
      generic: { ...DEFAULT_CONFIG.agents.generic, ...parsed.agents?.generic },
    },
    templates: { ...DEFAULT_CONFIG.templates, ...parsed.templates },
    kloop: {
      ...DEFAULT_CONFIG.kloop,
      ...migratedKloop,
      // Deep merge prompts
      prompts: {
        ...DEFAULT_CONFIG.kloop.prompts,
        ...(migratedKloop.prompts as Record<string, string> | undefined),
      },
    },
    settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
    repo: { ...DEFAULT_CONFIG.repo, ...parsed.repo },
  };
}
