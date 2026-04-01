import { z } from 'zod';
import { DEFAULT_TYPES } from './default-types';

// ============================================================================
// Log Entry
// ============================================================================

export interface LogEntry {
  ts: string;
  event: string;
  version?: number;
  attempt?: number;
  plan?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Session Status — re-exported from status.ts
// ============================================================================

export type { SessionStatus, TaskStatus } from './status';

// ============================================================================
// Kloop Config
// ============================================================================

export interface KloopPrompts {
  implementer?: string;
  reviewer?: string;
  checkpointer?: string;
}

export const kloopPromptsSchema = z
  .object({
    implementer: z.string().optional(),
    reviewer: z.string().optional(),
    checkpointer: z.string().optional(),
  })
  .optional();

export interface KloopConfig {
  implementers: Record<string, number>;
  reviewPhases: string[][];
  maxIterations: number;
  implementerTimeout: number;
  reviewerTimeout: number;
  conflictCheckThreshold: number;
  firstLoopFullReview: boolean;
  previousReviewPropagation: number;
  reviewerFailureLimit: number;
  prompts?: KloopPrompts;
}

export const kloopConfigSchema = z
  .object({
    implementers: z.record(z.string(), z.number()).default({ claude: 1 }),
    reviewPhases: z.array(z.array(z.string())).default([['claude']]),
    maxIterations: z.number().min(1).max(100).default(10),
    implementerTimeout: z.number().min(1).max(120).default(30),
    reviewerTimeout: z.number().min(1).max(120).default(15),
    conflictCheckThreshold: z.number().min(1).max(10).default(2),
    firstLoopFullReview: z.boolean().default(false),
    previousReviewPropagation: z.number().min(0).max(1).default(0),
    reviewerFailureLimit: z.number().min(1).max(10).default(2),
    prompts: kloopPromptsSchema,
  })
  .default({});

// ============================================================================
// Config
// ============================================================================

export interface AgentConfig {
  prompt: string;
  binary?: string;
}

// ============================================================================
// Type Config Schemas (for type-driven Phase 1)
// ============================================================================

export const reviewerSchema = z.object({
  desc: z.string(),
  prompt: z.string(),
  binaries: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});

export const typeConfigSchema = z.object({
  desc: z.string(),
  spec_writer: z.object({ prompt: z.string(), timeout: z.number().optional() }),
  spec_reviewers: z.record(z.string(), reviewerSchema).default({}),
  plan_writer: z.object({ prompt: z.string(), timeout: z.number().optional() }),
  plan_reviewers: z.record(z.string(), reviewerSchema).default({}),
  kloopPrompts: kloopPromptsSchema,
});

export type TypeConfig = z.infer<typeof typeConfigSchema>;
export type ReviewerConfig = z.infer<typeof reviewerSchema>;

// ============================================================================
// Main Config Schema
// ============================================================================

const agentSchema = z.object({
  prompt: z.string(),
  binary: z.string().optional(),
});

export const configSchema = z.object({
  claude_binary: z.string().default('claude'),
  agents: z
    .object({
      init: z.record(z.string(), agentSchema).default({}),
      phase2: z.record(z.string(), agentSchema).default({}),
      phase3: z.record(z.string(), agentSchema).default({}),
    })
    .default({ init: {}, phase2: {}, phase3: {} }),
  types: z.record(z.string(), typeConfigSchema).default({}),
  kloop: kloopConfigSchema,
  settings: z
    .object({
      maxPushCycles: z.number().min(1).max(20).default(10),
      pollInterval: z.number().min(5).max(300).default(60),
      defaultLlmTimeout: z.number().min(10).max(600).default(300),
    })
    .default({
      maxPushCycles: 10,
      pollInterval: 60,
      defaultLlmTimeout: 300,
    }),
  repo: z
    .object({
      org: z.string().optional(),
      baseBranch: z.string().default('main'),
      ticketSystem: z.string().nullable().default(null),
    })
    .default({
      baseBranch: 'main',
      ticketSystem: null,
    }),
});

export type Config = z.infer<typeof configSchema>;

// ============================================================================
// Default prompt strings (extracted from hardcoded values)
// ============================================================================

const DEFAULT_LOCAL_INIT_PROMPT = `You are setting up a task for kautopilot. Please:
1. Understand what this project needs (look at the codebase)
2. Write the ticket description to ~/.kautopilot/{sessionId}/artifacts/ticket.md
3. Write the task spec to ~/.kautopilot/{sessionId}/artifacts/v1/task-spec.md
4. Write implementation plans to ~/.kautopilot/{sessionId}/artifacts/v1/plans/plan-1.md

The ticket.md should describe the problem. The task-spec should describe the solution. Plans should be concrete steps.`;

const DEFAULT_ROUTE_TYPE_PROMPT = `Classify this ticket into one of the following types. Output JSON: {"type": "<name>"}

Available types:
{typeList}

Ticket content:
{ticketContent}

If unsure, pick the type that best matches. Output ONLY the JSON.`;

const DEFAULT_RESEARCH_TICKET_SYSTEM_PROMPT = `Research this task/ticket system: "{taskSystem}"

Generate a concise research doc covering:

a) What is it? (brief description)

b) Access methods — does it have:
   - A CLI tool? (name, install method)
   - A REST/GraphQL API? (base URL, auth method)
   - An MCP server? (package name, setup)
   - What is the standard/recommended way to interact with it programmatically?
   List ALL options with their pros/cons.

c) Structure/hierarchy:
   - How is work organized? (spaces → folders → lists, or projects → epics → stories, etc.)
   - What is the typical ticket/task hierarchy?

d) Ticket transitions:
   - How do status transitions work?
   - Are they simple (just set status) or complex (must follow workflow, use transition IDs)?
   - What are the typical states?
   - Are there restrictions on which transitions are valid?

Detected CLI tools on this system:
{detectedInfo}

Keep it factual and concise. Output as markdown.`;

const DEFAULT_RESEARCH_SETUP_PROMPT = `The user needs to set up access to "{taskSystem}" but it may be partially configured or not authenticated yet.

Access hint from the user: {accessMethod}

Based on the research above, propose the simplest setup path.

1. What is the recommended access method? (CLI, API token, MCP server)
2. Give step-by-step setup instructions
3. How to verify it works (test command)
4. If the user already has the CLI installed, include auth/context checks before assuming it works

Keep it concise and actionable.`;

const DEFAULT_CREATE_SCRIPTS_PROMPT = `You are creating ticket integration scripts for kautopilot.

## Context
Ticketing system: {taskSystem}
Access method: {accessMethod}
State mapping: {stateMapping}
{transitionNoOp}
Current branch: {branch}
Scripts dir: {scriptsDir}
{quirks}
Setup assessment: {setupAssessment}

## Research Doc (from earlier research)
{researchDoc}

Detected CLI tools:
{detectedInfo}

## Create Scripts

Create these scripts:
{scriptList}
{optionalScripts}

Script requirements:
- All scripts must be executable bash scripts (#!/usr/bin/env bash)
- Use set -euo pipefail for robustness
- extract-ticket: parse branch name to extract ticket ID
  - Current branch: "{branch}"
- get-ticket: output markdown content of the ticket
- Transition scripts:
  - Research how transitions work for this specific system
  - If transitions are complex (e.g., Jira workflows), use the correct transition IDs
  - Verify auth and project/site context are working before using API/CLI calls
  - For Jira/Atlassian CLI, do not guess workflow names or transition IDs; discover them first or fall back to a clear no-op with explanation

## Test

IMPORTANT: Test each script for real.

1. Test extract-ticket:
   echo "{branch}" | {scriptsDir}/extract-ticket
2. Test get-ticket with the extracted ID:
   {scriptsDir}/get-ticket <ticket-id>
3. Test transition scripts (if not no-ops):
   - Transition the ticket, verify it moved, then revert it back
   - Do NOT leave tickets in a wrong state

## Report

Output a SUMMARY with:
- Script name, Status (CREATED / NO-OP / FAILED), what you tried, test result
- If failed: why and how the user can fix it

NEVER leave a broken script — either it works or it is a no-op.`;

export const DEFAULT_CONFIG: Config = {
  claude_binary: 'claude',
  agents: {
    init: {
      localInit: {
        prompt: DEFAULT_LOCAL_INIT_PROMPT,
      },
      routeType: {
        prompt: DEFAULT_ROUTE_TYPE_PROMPT,
      },
      researchTicketSystem: {
        prompt: DEFAULT_RESEARCH_TICKET_SYSTEM_PROMPT,
      },
      researchSetup: {
        prompt: DEFAULT_RESEARCH_SETUP_PROMPT,
      },
      createScripts: {
        prompt: DEFAULT_CREATE_SCRIPTS_PROMPT,
      },
    },
    phase2: {
      resolve: {
        prompt: `Analyze the conflict or failure and discuss resolution options.
Consider: root cause, alternative approaches, scope reduction.
When resolved, document your approach clearly.`,
      },
      rewrite_spec: {
        prompt: `Rewrite the working spec to address the resolution.
Preserve what was working. Only change what needs to change.
Output ONLY the rewritten spec in markdown format.`,
      },
      commit: {
        prompt: `Generate a commit message following project conventions.
First line is the title (max 72 chars). Blank line, then body if needed.
Match the style of recent commits in the repo.`,
      },
    },
    phase3: {
      eval: {
        prompt: `Analyze PR feedback and decide what action to take.
Be precise: only suggest code_fix for genuine issues.
Mark items as ambiguous when you're unsure rather than guessing.`,
      },
      write_fix: {
        prompt: `Merge all pending code fixes into a single coherent implementation spec.
Deduplicate overlapping fixes on the same file.
Output the complete spec (not just the changes).`,
      },
      commit_pending: {
        prompt: `Generate a commit message for pending changes.
First line is the title. Match the style of recent commits.`,
      },
      prereview_classify: {
        prompt: `Classify CodeRabbit findings as fix/comment/ignore.
Be conservative — only mark as "fix" if it's a genuine issue.`,
      },
      prereview_fix: {
        prompt: `Apply the classified fixes to the codebase.
Be precise and minimal — only change what's needed.`,
      },
      tty_resolve_ambiguous: {
        prompt: `Help resolve ambiguous items from the PR review.
For each item, decide: reply, code fix, or skip.`,
      },
      tty_resolve_conflict: {
        prompt: `Help resolve merge conflicts from the rebase.
Resolve conflicts while preserving the intent of both changes.`,
      },
      tty_resolve_failure: {
        prompt: `The dev-loop execution failed. Help investigate and determine next steps.
Options: fix the issue and retry, skip and move on, or escalate.`,
      },
    },
  },
  types: DEFAULT_TYPES,
  kloop: {
    implementers: { claude: 1 },
    reviewPhases: [['claude']],
    maxIterations: 10,
    implementerTimeout: 30,
    reviewerTimeout: 15,
    conflictCheckThreshold: 2,
    firstLoopFullReview: false,
    previousReviewPropagation: 0,
    reviewerFailureLimit: 2,
  },
  settings: {
    maxPushCycles: 10,
    pollInterval: 60,
    defaultLlmTimeout: 300,
  },
  repo: {
    baseBranch: 'main',
    ticketSystem: null,
  },
};

// ============================================================================
// Session Row (index.db)
// ============================================================================

export type SessionState = 'init' | 'ready' | 'running' | 'done';

export interface SessionRow {
  id: string;
  repo_path: string;
  worktree: string;
  git_root: string;
  git_root_host: string;
  ticket_id: string | null;
  branch: string | null;
  local: number;
  state: SessionState;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Phase 3 Types
// ============================================================================

export type MergePolicy = 'merge' | 'squash' | 'rebase';

export type PollState = 'pending' | 'blocked' | 'mergeable';

export interface PollResult {
  state: PollState;
  threads: PollThread[];
  checkStatuses: CheckStatus[];
  mergePolicy?: MergePolicy;
}

export interface PollThread {
  id: string;
  isOutdated: boolean;
  author: string;
  body: string;
  firstCommentId: string;
  replies: PollReply[];
}

export interface PollReply {
  id: string;
  author: string;
  body: string;
  isBot: boolean;
}

export interface CheckStatus {
  name: string;
  status: 'pending' | 'passing' | 'failing';
}

export interface EvalResult {
  threadId: string;
  verdict: 'reply' | 'resolve' | 'code_fix' | 'skip';
  reply?: string;
  codeFix?: string;
  ambiguous?: boolean;
}

export type Verdict = 'approved' | 'rejected';

// ============================================================================
// Delivery Kind & Contract Model
// ============================================================================

export type DeliveryKind = 'pr' | 'ticket';

export interface ContractManifest {
  version: number;
  deliveryKind: DeliveryKind;
  specFile: string;
  planCount: number;
  createdAt: string;
  supersededBy?: number;
  supersededAt?: string;
}

export interface PlanManifest {
  plans: Array<{
    ordinal: number;
    activeRewrite: number;
    file: string;
    completed: boolean;
    commitSha?: string;
  }>;
}

export interface DeliveryManifest {
  kind: DeliveryKind;
  prNumber?: number;
  prUrl?: string;
  prRolloverHistory?: Array<{
    fromPr: number;
    toPr: number;
    reason: string;
    timestamp: string;
  }>;
  ticketArtifacts?: string[];
  publishedAt?: string;
}

// ============================================================================
// Rewrite Decision Types
// ============================================================================

export type RewriteDecision = 'refine_local' | 'patch_downstream' | 'regenerate_remaining' | 'revisit_spec';

// ============================================================================
// Phase Constants
// ============================================================================

export const PHASES = ['plan', 'implementation', 'polish'] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_ALIASES: Record<string, Phase> = {
  plan: 'plan',
  impl: 'implementation',
  implementation: 'implementation',
  polish: 'polish',
};

// ============================================================================
// Lock File
// ============================================================================

export interface LockInfo {
  locked: boolean;
  pid: number;
  alive: boolean;
}
