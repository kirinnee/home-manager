import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, SessionRow } from '../../core/types';
import type {
  InitState,
  InitOutcome,
  IdentifyArtifact,
  ResearchSummary,
  DetectionResult,
  SetupBrief,
  VerifyResult,
  OutcomeArtifact,
} from '../../core/init-types';
import { MAX_REPAIR_ATTEMPTS, CRITICAL_CAPABILITIES, NON_CRITICAL_CAPABILITIES } from '../../core/init-types';
import { appendInitEvent } from '../../core/log';
import { initDir, sessionDir, snapshotPath, ensureArtifactDir, sessionArtifactPath } from '../../core/artifacts';
import { getDefaultBinary, getAgentPrompt } from '../../core/agents';
import { spawnPrintRaw, spawnPrint } from '../../llm/spawn';
import { textInput, selectOption, confirmAction } from '../../llm/inquirer';
import {
  verifyCriticalScripts,
  loadOrgScripts,
  ALL_SCRIPTS,
  CRITICAL_SCRIPTS,
  OPTIONAL_SCRIPTS,
  promptSaveOrg,
} from '../../core/scripts';
import { upsertSession, updateSessionState } from '../../core/db';
import { updateInitOutcome, upsertInitAttempt, getInitAttemptById } from '../../core/init-db';
import { ensureInitStatus } from '../../core/init-status';
import { generateSessionId } from '../../core/id';
import { writeConfig, resolveConfig } from '../../core/config';
import {
  getGitRoot,
  getWorktree,
  getRemoteUrl,
  normalizeGitRoot,
  extractOrg,
  getCurrentBranch,
  createBranch,
  isOnMain,
} from '../../core/git';
import { renderMarkdown } from '../../util/markdown';
import { logField, logOk, logWarn, logInfo, logDim } from '../../util/format';

// ============================================================================
// Init Context — passed through all state handlers
// ============================================================================

export interface InitContext {
  initId: string;
  config: Config;
  workDir: string;
  gitRootPath: string;
  worktree: string;
  remoteUrl: string;
  gitRootHost: string;
  org: string | undefined;
  forceLocal: boolean;
  ticketIdArg: string | undefined;
}

export type InitStateHandler = (ctx: InitContext) => Promise<InitState | null>;
export type InitStateMap = Record<string, InitStateHandler>;

// ============================================================================
// Artifact helpers
// ============================================================================

function initArtifactPath(initId: string, ...segments: string[]): string {
  return join(initDir(initId), ...segments);
}

function writeInitArtifact(initId: string, filename: string, content: string): void {
  const path = initArtifactPath(initId, filename);
  mkdirSync(join(initDir(initId)), { recursive: true });
  writeFileSync(path, content);
}

function writeInitArtifactJson(initId: string, filename: string, data: unknown): void {
  writeInitArtifact(initId, filename, JSON.stringify(data, null, 2));
}

// ============================================================================
// State: identify
// ============================================================================

export const identify: InitStateHandler = async ctx => {
  const { initId } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'identify:started' });

  if (ctx.forceLocal) {
    appendInitEvent(initId, {
      ts: new Date().toISOString(),
      event: 'identify:completed',
      metadata: { systemName: 'local' },
    });
    appendInitEvent(initId, {
      ts: new Date().toISOString(),
      event: 'context:updated',
      metadata: { systemName: 'local', localMode: true },
    });
    writeInitArtifactJson(initId, 'identify.json', {
      systemName: 'local',
      timestamp: new Date().toISOString(),
    } satisfies IdentifyArtifact);
    return 'downgrade_local';
  }

  const taskSystem = await textInput(
    'What task/ticket system do you use? (e.g., "ClickUp", "Jira", "GitHub Issues", "Linear")',
    '',
  );

  if (!taskSystem.trim()) {
    logInfo('No task system specified. Falling back to local mode.');
    appendInitEvent(initId, {
      ts: new Date().toISOString(),
      event: 'identify:completed',
      metadata: { systemName: 'none' },
    });
    return 'downgrade_local';
  }

  const systemName = taskSystem.trim();

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { systemName },
  });

  writeInitArtifactJson(initId, 'identify.json', {
    systemName,
    timestamp: new Date().toISOString(),
  } satisfies IdentifyArtifact);

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'identify:completed',
    metadata: { systemName },
  });

  return 'research';
};

// ============================================================================
// State: research
// ============================================================================

export const research: InitStateHandler = async ctx => {
  const { initId } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'research:started' });

  // Read system name from context artifact
  const identifyPath = initArtifactPath(initId, 'identify.json');
  const identifyData: IdentifyArtifact = JSON.parse(readFileSync(identifyPath, 'utf-8'));
  const systemName = identifyData.systemName;

  // Detect local tools
  const detected = detectTicketingTools();
  const detectedNames = Object.keys(detected);
  const detectedInfo =
    detectedNames.length > 0 ? detectedNames.map(n => `  - ${n}: ${detected[n]}`).join('\n') : '  (none detected)';

  // LLM research
  const researchPrompt = getAgentPrompt('init', 'researchTicketSystem', {
    taskSystem: systemName,
    detectedInfo,
  });

  const researchDoc = await spawnPrintRaw(getDefaultBinary(), researchPrompt, {
    cwd: ctx.workDir,
    spinnerMsg: `Researching ${systemName}`,
    sessionId: initId,
    label: 'research-task-system',
  });

  // Derive detection plan from research output (spec section 3.2)
  const detectionPlan = buildDetectionPlan(systemName, researchDoc || '');

  // Parse structured fields from LLM markdown output (spec section 3.2 — machine-usable research output)
  const parsePrompt = `Parse this research doc and extract structured fields. Output ONLY valid JSON with this exact shape:
{
  "accessPaths": [{"method": "string", "tool": "string", "available": bool, "notes": "string"}],
  "hierarchy": "string",
  "transitionModel": "string",
  "constraints": ["string"],
  "followUpQuestions": ["string"]
}
If a field cannot be determined from the doc, use an empty array or "unknown".

Research doc:
---
${researchDoc || '(no research output)'}
---`;

  const parsedJson = await spawnPrintRaw(getDefaultBinary(), parsePrompt, {
    cwd: ctx.workDir,
    spinnerMsg: `Parsing research for ${systemName}`,
    sessionId: initId,
    label: 'parse-research',
  });

  let structured: ResearchSummary | null = null;
  if (parsedJson) {
    try {
      // Strip markdown code fences if present
      const jsonStr = parsedJson
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      structured = JSON.parse(jsonStr) as ResearchSummary;
    } catch {
      // Best-effort parsing — fall back to defaults
    }
  }

  const researchSummary: ResearchSummary = structured ?? {
    systemName,
    accessPaths: [],
    hierarchy: 'unknown',
    transitionModel: 'unknown',
    constraints: [],
    detectionPlan,
    detectedTools: detected,
    followUpQuestions: [],
    timestamp: new Date().toISOString(),
  };

  // Ensure all required fields are always set (may be missing when structured parsing succeeded)
  researchSummary.systemName = systemName;
  researchSummary.timestamp = new Date().toISOString();
  researchSummary.detectionPlan = detectionPlan;
  researchSummary.detectedTools = detected;

  // Write research artifacts
  writeInitArtifact(initId, 'research.md', researchDoc || '(no research output)');
  writeInitArtifactJson(initId, 'research.json', researchSummary);

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { detectedTools: detected },
  });

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'research:completed',
    metadata: { systemName },
  });

  return 'detect';
};

// ============================================================================
// State: detect
// ============================================================================

export const detect: InitStateHandler = async ctx => {
  const { initId } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'detect:started' });

  // Read research context including detection plan (spec section 3.3)
  const researchPath = initArtifactPath(initId, 'research.json');
  const researchData = JSON.parse(readFileSync(researchPath, 'utf-8'));
  const detected = (researchData.detectedTools ?? {}) as Record<string, string>;
  const detectionPlan: ResearchSummary['detectionPlan'] = researchData.detectionPlan || [];

  // Execute research-derived detection plan
  const configFiles: Record<string, boolean> = {};
  const authStatus: Record<string, 'authenticated' | 'not_authenticated' | 'unknown'> = {};
  const available: string[] = Object.keys(detected);
  const missing: string[] = [];

  for (const step of detectionPlan) {
    try {
      if (step.type === 'binary' && step.command) {
        const cmd = step.command.split(/\s+/);
        const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
        if (proc.exitCode === 0 || proc.exitCode === null) {
          if (!available.includes(step.check)) available.push(step.check);
        } else {
          missing.push(step.check);
        }
      } else if (step.type === 'config') {
        const configPath = step.command || step.check;
        const resolvedPath = configPath.replace('~', process.env.HOME!);
        configFiles[configPath] = existsSync(resolvedPath);
      } else if (step.type === 'auth' && step.command) {
        const cmd = step.command.split(/\s+/);
        const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
        if (proc.exitCode === 0) {
          authStatus[step.check] = 'authenticated';
        } else {
          authStatus[step.check] = 'not_authenticated';
          // Failed auth means tool is unavailable (present but not working)
          if (!missing.includes(step.check)) missing.push(step.check);
        }
      } else if (step.type === 'cli_test' && step.command) {
        const cmd = step.command.split(/\s+/);
        const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
        if (proc.exitCode === 0) {
          authStatus[step.check] = 'authenticated';
        } else {
          authStatus[step.check] = 'not_authenticated';
          if (!missing.includes(step.check)) missing.push(step.check);
        }
      }
    } catch {
      // Detection step failed — mark as unknown
      authStatus[step.check] = 'unknown';
    }
  }

  const detectionResult: DetectionResult = {
    tools: detected,
    configFiles,
    authStatus,
    available,
    missing,
    uncertain: Object.keys(authStatus).filter(k => authStatus[k] === 'unknown'),
    timestamp: new Date().toISOString(),
  };

  writeInitArtifactJson(initId, 'detection.json', detectionResult);

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'detect:completed',
    metadata: { available: available.length, missing: missing.length, uncertain: detectionResult.uncertain.length },
  });

  return 'gather_context';
};

// ============================================================================
// State: gather_context
// ============================================================================

export const gather_context: InitStateHandler = async ctx => {
  const { initId } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'gather_context:started' });

  // Read context from prior phases
  const identifyData: IdentifyArtifact = JSON.parse(readFileSync(initArtifactPath(initId, 'identify.json'), 'utf-8'));
  const detectionData: DetectionResult = JSON.parse(readFileSync(initArtifactPath(initId, 'detection.json'), 'utf-8'));

  const systemName = identifyData.systemName;
  const detectedNames = Object.keys(detectionData.tools);
  const toolHint = detectedNames.length > 0 ? ` Detected: ${detectedNames.join(', ')}.` : '';

  // One broad context-aware question (spec section 3.4)
  const contextAnswer = await textInput(
    `Tell me about your ${systemName} setup.${toolHint}\n` +
      'How do you access tickets? Is it authenticated? ' +
      'What are your ticket states (e.g., todo → in-progress → review)? ' +
      'Any defaults, quirks, or restrictions?',
    'e.g., "I use the gh CLI, states are open/in-progress/review, always in project X"',
  );

  // Classify access readiness
  const accessSetup = classifyAccessSetup(contextAnswer);

  if (accessSetup.needsSetupHelp) {
    logDim('Researching setup instructions...');
    const setupPrompt = getAgentPrompt('init', 'researchSetup', {
      taskSystem: systemName,
      accessMethod: contextAnswer.trim() || 'unknown',
    });

    const setupInstructions = await spawnPrintRaw(getDefaultBinary(), setupPrompt, {
      cwd: ctx.workDir,
      spinnerMsg: 'Researching setup instructions',
      sessionId: initId,
      label: 'research-setup',
    });

    if (setupInstructions) {
      console.log('\n' + renderMarkdown(setupInstructions) + '\n');
    }

    const setupChoice = await selectOption<'done' | 'local'>('What would you like to do?', [
      { value: 'done', label: 'I have set it up', hint: 'Continue with ticket integration' },
      { value: 'local', label: 'Downgrade to local mode', hint: 'Skip ticket integration' },
    ]);

    if (setupChoice === 'local') {
      appendInitEvent(initId, {
        ts: new Date().toISOString(),
        event: 'gather_context:completed',
        metadata: { downgrade: true },
      });
      return 'downgrade_local';
    }
  }

  // Write user context artifact
  writeInitArtifactJson(initId, 'user-context.json', {
    systemName,
    userAnswer: contextAnswer.trim(),
    accessAssessment: accessSetup.assessment,
    needsSetupHelp: accessSetup.needsSetupHelp,
    timestamp: new Date().toISOString(),
  });

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: {
      accessMethod: contextAnswer.trim(),
      setupAssessment: accessSetup.assessment,
    },
  });

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'gather_context:completed',
  });

  return 'normalize';
};

// ============================================================================
// State: normalize
// ============================================================================

export const normalize: InitStateHandler = async ctx => {
  const { initId } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'normalize:started' });

  // Read prior artifacts
  const identifyData = JSON.parse(readFileSync(initArtifactPath(initId, 'identify.json'), 'utf-8'));
  const researchData = JSON.parse(readFileSync(initArtifactPath(initId, 'research.json'), 'utf-8'));
  const detectionData = JSON.parse(readFileSync(initArtifactPath(initId, 'detection.json'), 'utf-8'));
  const userContext = JSON.parse(readFileSync(initArtifactPath(initId, 'user-context.json'), 'utf-8'));

  // Parse state mapping from user answer
  const userAnswer = (userContext.userAnswer as string) || '';
  const stateMapping = parseStateMapping(userAnswer);
  const noOp = /doesn'?t map|doesn'?t apply|no\s*op|skip|n\/a|none/i.test(userAnswer);

  // Determine access path from detection results and user answer.
  // Maps user/ticket-system identifiers to access-path labels for the setup brief.
  // The detect phase is research-driven via buildDetectionPlan(); this is label mapping only.
  const detectedTools = Object.keys(detectionData.tools || {});
  let chosenAccessPath = 'cli';
  const userAnswerLower = userAnswer.toLowerCase();
  const detectedToolKeys = detectedTools.map(t => t.toLowerCase());
  if (
    detectedToolKeys.some(t => t.includes('github')) ||
    userAnswerLower.includes('gh ') ||
    userAnswerLower.includes('github')
  ) {
    chosenAccessPath = 'gh-cli';
  } else if (detectedToolKeys.some(t => t.includes('jira')) || userAnswerLower.includes('jira')) {
    chosenAccessPath = 'jira-cli';
  } else if (detectedToolKeys.some(t => t.includes('linear')) || userAnswerLower.includes('linear')) {
    chosenAccessPath = 'linear-cli';
  } else if (detectedToolKeys.some(t => t.includes('clickup')) || userAnswerLower.includes('clickup')) {
    chosenAccessPath = 'clickup-cli';
  } else if (detectedToolKeys.some(t => t.includes('asana')) || userAnswerLower.includes('asana')) {
    chosenAccessPath = 'asana-cli';
  } else if (detectedToolKeys.some(t => t.includes('notion')) || userAnswerLower.includes('notion')) {
    chosenAccessPath = 'notion-cli';
  } else if (userAnswerLower.includes('api') || userAnswerLower.includes('rest')) {
    chosenAccessPath = 'api';
  } else if (userAnswerLower.includes('mcp') || userAnswerLower.includes('model context')) {
    chosenAccessPath = 'mcp';
  }

  // Determine readiness
  const isAuthenticated = Object.values(detectionData.authStatus || {}).some((s: unknown) => s === 'authenticated');
  const readiness = isAuthenticated ? 'ready' : detectedTools.length > 0 ? 'partial' : 'not_ready';

  // Parse quirks
  const quirks: string[] = [];
  if (userAnswer.includes('always') || userAnswer.includes('only') || userAnswer.includes('must')) {
    quirks.push(userAnswer);
  }

  // Derive defaults from research + detection + user context (spec section 3.5)
  const defaults: Record<string, string> = {};
  if (researchData.constraints?.length > 0) {
    defaults.constraints = (researchData.constraints as string[]).join('; ');
  }
  if (researchData.transitionModel && researchData.transitionModel !== 'unknown') {
    defaults.transitionModel = researchData.transitionModel;
  }
  if (detectedTools.length > 0) {
    defaults.detectedTools = detectedTools.join(', ');
  }
  if (userAnswer.trim()) {
    defaults.userContext = userAnswer.trim();
  }

  const setupBrief: SetupBrief = {
    systemName: identifyData.systemName,
    chosenAccessPath,
    readiness: readiness as SetupBrief['readiness'],
    confidence: readiness === 'ready' ? 'high' : readiness === 'partial' ? 'medium' : 'low',
    hierarchy: researchData.hierarchy || 'unknown',
    defaults,
    stateMapping: {
      todo: stateMapping.todo || 'open',
      inProgress: stateMapping.inProgress || 'in progress',
      inReview: stateMapping.inReview || 'review',
      noOp,
    },
    quirks,
    requiredCapabilities: [...CRITICAL_CAPABILITIES],
    noOpCapabilities: noOp ? [...NON_CRITICAL_CAPABILITIES] : [],
    timestamp: new Date().toISOString(),
  };

  writeInitArtifactJson(initId, 'setup-brief.json', setupBrief);

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: {
      stateMapping: `${setupBrief.stateMapping.todo} → ${setupBrief.stateMapping.inProgress} → ${setupBrief.stateMapping.inReview}`,
    },
  });

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'normalize:completed',
  });

  return 'generate';
};

// ============================================================================
// State: generate
// ============================================================================

export const generate: InitStateHandler = async ctx => {
  const { initId, workDir, org } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'generate:started' });

  const scriptsDir = join(initDir(initId), 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const effectiveOrg = org || 'default';
  const branch = getCurrentBranch(workDir);

  // Try org scripts first
  const { found, missing } = loadOrgScripts(scriptsDir, effectiveOrg);

  if (missing.length === 0) {
    // All scripts loaded from org
    logOk('All scripts loaded from org config');
    appendInitEvent(initId, {
      ts: new Date().toISOString(),
      event: 'generate:completed',
      metadata: { source: 'org', found: found.length },
    });
    return 'verify';
  }

  // Read setup brief for generation context
  const setupBrief: SetupBrief = JSON.parse(readFileSync(initArtifactPath(initId, 'setup-brief.json'), 'utf-8'));
  const researchDoc = readFileSync(initArtifactPath(initId, 'research.md'), 'utf-8');
  const detectionData = JSON.parse(readFileSync(initArtifactPath(initId, 'detection.json'), 'utf-8'));
  const userContext = JSON.parse(readFileSync(initArtifactPath(initId, 'user-context.json'), 'utf-8'));

  const detectedNames = Object.keys(detectionData.tools || {});
  const detectedInfo =
    detectedNames.length > 0
      ? detectedNames.map(n => `  - ${n}: ${detectionData.tools[n]}`).join('\n')
      : '  (none detected)';

  const scriptInterfaces: Record<string, string> = {
    'extract-ticket': 'reads branch name from stdin, outputs ticket ID to stdout',
    'get-ticket': 'takes ticket ID as $1, outputs ticket markdown to stdout',
    'start-ticket': 'takes ticket ID as $1, transitions ticket from todo to in-progress',
    'to-review': 'takes ticket ID as $1, transitions ticket from in-progress to review',
    'revert-to-inprogress': 'takes ticket ID as $1, transitions ticket from review back to in-progress',
    'update-ticket': 'takes ticket ID as $1 and update content as $2, updates the ticket description/body',
    'create-downstream-ticket':
      'takes parent ticket ID as $1 and content as $2, creates a linked downstream ticket, outputs new ticket ID',
    'add-comment': 'takes ticket ID as $1 and comment text as $2, adds a comment to the ticket',
    'move-to-todo': 'takes ticket ID as $1, transitions ticket to todo/backlog state',
    'attach-artifact': 'takes ticket ID as $1 and file path as $2, attaches or links the file to the ticket',
  };

  const transitionNoOp = setupBrief.stateMapping.noOp;

  const scriptsToCreate = transitionNoOp ? missing.filter(s => CRITICAL_SCRIPTS.includes(s)) : missing;

  const scriptList = scriptsToCreate.map(s => `- ${s}: ${scriptInterfaces[s]}`).join('\n');
  const optionalScriptsSection =
    transitionNoOp && missing.some(s => OPTIONAL_SCRIPTS.includes(s))
      ? '\nThese transition scripts should be NO-OPS:\n' +
        missing
          .filter(s => OPTIONAL_SCRIPTS.includes(s))
          .map(s => `- ${s}: #!/bin/bash\n# no-op (state mapping not applicable)\nexit 0`)
          .join('\n')
      : '';

  const transitionNoOpSection = transitionNoOp
    ? 'NOTE: Transition scripts should be NO-OPS (exit 0). User says states do not map well.'
    : '';

  const prompt = getAgentPrompt('init', 'createScripts', {
    taskSystem: setupBrief.systemName,
    accessMethod: userContext.userAnswer || '',
    stateMapping: `${setupBrief.stateMapping.todo} → ${setupBrief.stateMapping.inProgress} → ${setupBrief.stateMapping.inReview}`,
    transitionNoOp: transitionNoOpSection,
    branch,
    scriptsDir,
    quirks: setupBrief.quirks.length > 0 ? `Context/quirks: ${setupBrief.quirks.join(', ')}` : '',
    setupAssessment: `readiness: ${setupBrief.readiness}, confidence: ${setupBrief.confidence}`,
    researchDoc: researchDoc || '(no research available)',
    detectedInfo,
    scriptList,
    optionalScripts: optionalScriptsSection,
  });

  // Bounded repair loop (spec section 5.2)
  let repairAttempt = 0;
  let activePrompt = prompt;
  while (repairAttempt < MAX_REPAIR_ATTEMPTS) {
    const llmOutput = await spawnPrintRaw(getDefaultBinary(), activePrompt, {
      cwd: workDir,
      spinnerMsg:
        repairAttempt === 0
          ? `Creating ${setupBrief.systemName} integration scripts`
          : `Repairing scripts (attempt ${repairAttempt + 1}/${MAX_REPAIR_ATTEMPTS})`,
      sessionId: initId,
      label: repairAttempt === 0 ? 'create-scripts' : `repair-scripts-${repairAttempt}`,
    });

    if (llmOutput) {
      console.log(renderMarkdown(llmOutput));
      console.log();
    }

    // Create no-op transition scripts if states don't map
    if (transitionNoOp) {
      for (const name of OPTIONAL_SCRIPTS) {
        if (missing.includes(name)) {
          const dest = join(scriptsDir, name);
          writeFileSync(dest, '#!/bin/bash\n# no-op\nexit 0\n');
          Bun.spawnSync({ cmd: ['chmod', '+x', dest] });
        }
      }
    }

    // Make all scripts executable
    for (const name of ALL_SCRIPTS) {
      const dest = join(scriptsDir, name);
      if (existsSync(dest)) {
        Bun.spawnSync({ cmd: ['chmod', '+x', dest] });
      }
    }

    // Verify
    const result = verifyCriticalScripts(scriptsDir, branch);
    if (result.extractTicketId && result.getTicketOk) {
      logOk('Critical scripts verified successfully');
      break;
    }

    repairAttempt++;
    if (repairAttempt < MAX_REPAIR_ATTEMPTS) {
      // Build repair prompt with concrete verification failure details (spec section 5.2)
      const failures: string[] = [];
      if (!result.extractTicketId) {
        failures.push(`extract-ticket FAILED: Given branch "${branch}", the script did not output a valid ticket ID.`);
      }
      if (!result.getTicketOk) {
        failures.push(`get-ticket FAILED: The script did not return usable ticket content.`);
      }
      activePrompt =
        prompt +
        `\n\n--- REPAIR CONTEXT ---\n` +
        `This is repair attempt ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}.\n` +
        `The previous scripts failed verification with these specific errors:\n` +
        failures.map(f => `- ${f}`).join('\n') +
        `\n` +
        `Inspect the existing scripts in ${scriptsDir}, identify the root cause of each failure, and fix them.\n` +
        `Do NOT regenerate from scratch — read the failing scripts, diagnose, and repair.\n`;
      logWarn(
        `Critical scripts failed verification (attempt ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}). Retrying with failure details...`,
      );
    }
  }

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { repairAttempts: repairAttempt, maxRepairAttempts: MAX_REPAIR_ATTEMPTS },
  });

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'generate:completed',
    metadata: { repairAttempts: repairAttempt },
  });

  return 'verify';
};

// ============================================================================
// State: verify
// ============================================================================

export const verify: InitStateHandler = async ctx => {
  const { initId, workDir } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'verify:started' });

  const scriptsDir = join(initDir(initId), 'scripts');
  const branch = getCurrentBranch(workDir);

  // Verify critical scripts
  const critical = verifyCriticalScripts(scriptsDir, branch);

  // Verify non-critical scripts
  const nonCritical: Record<string, { ok: boolean; noOp: boolean; error?: string }> = {};
  for (const name of OPTIONAL_SCRIPTS) {
    const scriptFile = join(scriptsDir, name);
    if (!existsSync(scriptFile)) {
      nonCritical[name] = { ok: false, noOp: false, error: 'missing' };
      continue;
    }
    const content = readFileSync(scriptFile, 'utf-8');
    const isNoOp = content.includes('# no-op') || (content.includes('exit 0') && content.split('\n').length <= 4);
    nonCritical[name] = { ok: true, noOp: isNoOp };
  }

  // Read actual repair attempt count from generate phase context
  const initStatus = ensureInitStatus(initId);
  const repairAttempts = initStatus.context.repairAttempts ?? 0;

  const verifyResult: VerifyResult = {
    extractTicket: {
      ok: !!critical.extractTicketId,
      ticketId: critical.extractTicketId,
      error: critical.extractTicketId ? undefined : 'no ticket ID extracted',
    },
    getTicket: {
      ok: critical.getTicketOk,
      contentLength: critical.getTicketOk ? 1 : 0,
      error: critical.getTicketOk ? undefined : 'no usable content',
    },
    nonCritical,
    repairAttempts,
    timestamp: new Date().toISOString(),
  };

  writeInitArtifactJson(initId, 'verify.json', verifyResult);

  if (!critical.extractTicketId || !critical.getTicketOk) {
    // Critical failure — ask user
    logWarn('Critical scripts did not pass verification.');

    // After bounded repair loop is exhausted, only offer local mode (spec section 5.3)
    const exhausted = repairAttempts >= MAX_REPAIR_ATTEMPTS;

    let fix: 'retry' | 'regenerate' | 'local';
    if (exhausted) {
      // Post-exhaustion: critical failure cannot promote, only local mode is allowed
      fix = await selectOption<'local'>(
        'Critical scripts are not working after maximum repair attempts. What would you like to do?',
        [{ value: 'local', label: 'Use local mode', hint: 'Skip ticket integration entirely' }],
      );
    } else {
      fix = await selectOption<'retry' | 'regenerate' | 'local'>(
        'Critical scripts are not working. What would you like to do?',
        [
          { value: 'retry', label: 'Retry', hint: 'Fix your tool/auth, then we verify again' },
          { value: 'regenerate', label: 'Regenerate', hint: 'Go back to generate phase' },
          { value: 'local', label: 'Use local mode', hint: 'Skip ticket integration entirely' },
        ],
      );
    }

    if (fix === 'local') {
      appendInitEvent(initId, {
        ts: new Date().toISOString(),
        event: 'verify:completed',
        metadata: { criticalOk: false, downgrade: true },
      });
      return 'downgrade_local';
    }

    if (fix === 'regenerate') {
      appendInitEvent(initId, {
        ts: new Date().toISOString(),
        event: 'verify:completed',
        metadata: { criticalOk: false, regenerate: true },
      });
      return 'generate';
    }

    // Retry: user fixes externally, then re-verify
    await textInput('Press Enter when ready to re-verify...', '');
    appendInitEvent(initId, {
      ts: new Date().toISOString(),
      event: 'verify:completed',
      metadata: { criticalOk: false, retry: true },
    });
    return 'verify'; // Loop back
  }

  // Determine if degraded
  const degradedCapabilities = Object.entries(nonCritical)
    .filter(([_, v]) => !v.ok)
    .map(([k]) => k);

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: {
      ticketId: critical.extractTicketId,
    },
  });

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'verify:completed',
    metadata: {
      criticalOk: true,
      degradedCapabilities: degradedCapabilities.length > 0 ? degradedCapabilities : undefined,
    },
  });

  return 'promote';
};

// ============================================================================
// State: promote
// ============================================================================

export const promote: InitStateHandler = async ctx => {
  const { initId, config, workDir, gitRootPath, worktree, remoteUrl, gitRootHost, org, ticketIdArg } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'promote:started' });

  // Promotion freshness guard (spec section 8.6, invariant 11.5/11.6)
  // Only promote from the active, non-terminal init attempt.
  const attempt = getInitAttemptById(initId);
  if (!attempt) {
    throw new Error(`Init attempt ${initId} not found in index — cannot promote.`);
  }
  if (attempt.outcome !== null) {
    throw new Error(
      `Init attempt ${initId} has outcome "${attempt.outcome}" — stale/abandoned attempts cannot be promoted.`,
    );
  }

  // Read verification result
  const verifyResult: VerifyResult = JSON.parse(readFileSync(initArtifactPath(initId, 'verify.json'), 'utf-8'));

  // Determine outcome
  const degradedCapabilities = Object.entries(verifyResult.nonCritical)
    .filter(([_, v]) => !v.ok)
    .map(([k]) => k);
  const noOpCapabilities = Object.entries(verifyResult.nonCritical)
    .filter(([_, v]) => v.noOp)
    .map(([k]) => k);

  const outcome: InitOutcome = degradedCapabilities.length > 0 ? 'promoted_degraded' : 'promoted';

  // Create runtime session
  const sessionId = generateSessionId();
  const now = new Date().toISOString();
  const sDir = sessionDir(sessionId);
  mkdirSync(sDir, { recursive: true });

  // Copy scripts from init attempt to runtime session
  const initScriptsDir = join(initDir(initId), 'scripts');
  const sessionScriptsDir = join(sDir, 'scripts');
  mkdirSync(sessionScriptsDir, { recursive: true });
  if (existsSync(initScriptsDir)) {
    for (const name of readdirSync(initScriptsDir)) {
      copyFileSync(join(initScriptsDir, name), join(sessionScriptsDir, name));
      Bun.spawnSync({ cmd: ['chmod', '+x', join(sessionScriptsDir, name)] });
    }
  }

  // Write config
  config.repo.org = org;
  config.repo.ticketSystem = null;
  writeConfig(sessionId, config);

  // Resolve ticket ID
  const branch = getCurrentBranch(workDir);
  let resolvedTicketId: string | undefined;

  if (ticketIdArg) {
    resolvedTicketId = ticketIdArg;
  } else if (verifyResult.extractTicket.ticketId) {
    resolvedTicketId = verifyResult.extractTicket.ticketId;
  }

  if (!resolvedTicketId) {
    throw new Error('Could not extract ticket ID from branch. Provide one: kautopilot init PE-1234');
  }

  // Determine branch
  let sessionBranch = branch;
  if (isOnMain(config.repo.baseBranch, workDir)) {
    sessionBranch = `feature/${resolvedTicketId}`;
    createBranch(sessionBranch, workDir);
  }

  // Create DB entry for runtime session
  upsertSession({
    id: sessionId,
    repo_path: gitRootPath,
    worktree,
    git_root: remoteUrl,
    git_root_host: gitRootHost,
    ticket_id: resolvedTicketId ?? null,
    branch: sessionBranch,
    local: 0,
    state: 'ready',
    created_at: now,
    updated_at: now,
  });

  // Update init attempt with outcome
  updateInitOutcome(initId, outcome, sessionId);

  // Write outcome artifact
  const manualActions = noOpCapabilities.map(c => `${c} (no-op — must be done manually)`);
  const outcomeArtifact: OutcomeArtifact = {
    outcome,
    promotedSessionId: sessionId,
    criticalScriptsWorking: true,
    degradedCapabilities,
    manualActions,
    timestamp: now,
  };
  writeInitArtifactJson(initId, 'outcome.json', outcomeArtifact);

  // Inform user of degraded capabilities
  if (outcome === 'promoted_degraded') {
    logWarn('Promoted with degraded capabilities:');
    for (const action of manualActions) {
      logWarn(`  - ${action}`);
    }
  }

  // Offer to save as org config
  if (org && org !== 'default') {
    await promptSaveOrg(sessionScriptsDir, org, sessionId);
  }

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'promote:completed',
    metadata: { outcome, sessionId, ticketId: resolvedTicketId },
  });

  logOk(`Session initialized: ${sessionId}`);
  logField('Ticket', resolvedTicketId);
  logField('Branch', sessionBranch);
  logField('Init attempt', initId);
  logDim(`Config:    ~/.kautopilot/${sessionId}/config.yaml`);
  logDim('Next:      kautopilot start');

  return null; // Terminal — init complete
};

// ============================================================================
// State: downgrade_local
// ============================================================================

export const downgrade_local: InitStateHandler = async ctx => {
  const { initId, config, workDir, gitRootPath, worktree, remoteUrl, gitRootHost, org } = ctx;

  appendInitEvent(initId, { ts: new Date().toISOString(), event: 'downgrade_local:started' });

  // Promotion freshness guard (spec section 8.6, invariant 11.5/11.6)
  const attempt = getInitAttemptById(initId);
  if (!attempt) {
    throw new Error(`Init attempt ${initId} not found in index — cannot promote to local mode.`);
  }
  if (attempt.outcome !== null) {
    throw new Error(
      `Init attempt ${initId} has outcome "${attempt.outcome}" — stale/abandoned attempts cannot be promoted.`,
    );
  }

  // Create runtime session in local mode
  const sessionId = generateSessionId();
  const now = new Date().toISOString();
  const sDir = sessionDir(sessionId);
  mkdirSync(sDir, { recursive: true });

  // Write config
  config.repo.org = org;
  config.repo.ticketSystem = null;
  writeConfig(sessionId, config);

  // Local ticket ID
  const localTicketId = `local-${generateSessionId().slice(0, 6)}`;

  // Collect ticket content via TTY (spec section 7)
  const ticketContent = await textInput(
    'Describe the task/ticket for this local session:',
    'e.g., "Refactor auth middleware to support JWT tokens"',
  );
  const ticketBody = `# ${localTicketId}\n\n${ticketContent.trim() || '(no description provided)'}\n`;

  // Write to spec/ticket.md at the worktree root — the canonical runtime ticket path
  // that pull-ticket.ts reads (prevents placeholder overwrite)
  const specDir = join(worktree, 'spec');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, 'ticket.md'), ticketBody);

  // Also snapshot to the session artifact path for runtime consumption
  const artifactDest = sessionArtifactPath(sessionId, 'ticket.md');
  ensureArtifactDir(artifactDest);
  writeFileSync(artifactDest, ticketBody);

  // Determine branch
  let branch = getCurrentBranch(workDir);
  if (isOnMain(config.repo.baseBranch, workDir)) {
    branch = `feature/${localTicketId}`;
    createBranch(branch, workDir);
  }

  // Write no-op adapter scripts for local mode (spec section 7 — fully disabled/no-op)
  const sessionScriptsDir = join(sDir, 'scripts');
  mkdirSync(sessionScriptsDir, { recursive: true });
  for (const scriptName of ALL_SCRIPTS) {
    const dest = join(sessionScriptsDir, scriptName);
    writeFileSync(dest, '#!/bin/bash\n# no-op (local mode — ticket integration disabled)\nexit 0\n');
    Bun.spawnSync({ cmd: ['chmod', '+x', dest] });
  }

  // Create DB entry for runtime session
  upsertSession({
    id: sessionId,
    repo_path: gitRootPath,
    worktree,
    git_root: remoteUrl,
    git_root_host: gitRootHost,
    ticket_id: localTicketId,
    branch,
    local: 1,
    state: 'ready',
    created_at: now,
    updated_at: now,
  });

  // Update init attempt
  updateInitOutcome(initId, 'downgraded_local', sessionId);

  // Write outcome
  const outcomeArtifact: OutcomeArtifact = {
    outcome: 'downgraded_local',
    promotedSessionId: sessionId,
    criticalScriptsWorking: false,
    degradedCapabilities: [...CRITICAL_CAPABILITIES, ...NON_CRITICAL_CAPABILITIES],
    manualActions: ['All ticket operations must be done manually'],
    timestamp: now,
  };
  writeInitArtifactJson(initId, 'outcome.json', outcomeArtifact);

  // If local mode explicitly requested, generate ticket/spec/plans via LLM
  if (ctx.forceLocal) {
    logInfo('Generating ticket, spec, and plans...');

    const specArtifactPath = snapshotPath(sessionId, 1, 'task-spec.md');
    const plansArtifactDir = snapshotPath(sessionId, 1, 'plans');
    ensureArtifactDir(specArtifactPath);
    ensureArtifactDir(plansArtifactDir + '/.keep');

    try {
      const localInitPrompt = getAgentPrompt('init', 'localInit', { sessionId });
      await spawnPrintRaw(getDefaultBinary(), localInitPrompt, {
        cwd: workDir,
        timeout: 300,
        spinnerMsg: 'Generating ticket, spec, and plans',
      });
    } catch (err) {
      logWarn('Local mode generation encountered an issue: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'downgrade_local:completed',
    metadata: { sessionId, ticketId: localTicketId },
  });

  logOk(`Session initialized (local mode): ${sessionId}`);
  logField('Ticket', localTicketId);
  logField('Branch', branch);
  logField('Init attempt', initId);
  logDim(`Config:    ~/.kautopilot/${sessionId}/config.yaml`);
  logDim('Next:      kautopilot start');

  return null; // Terminal
};

// ============================================================================
// Terminal states (no-op handlers)
// ============================================================================

export const failed: InitStateHandler = async ctx => {
  const { initId } = ctx;
  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'init:failed',
    metadata: { reason: 'terminal_state' },
  });
  updateInitOutcome(initId, 'failed');
  logWarn('Init failed.');
  return null;
};

export const cancelled: InitStateHandler = async ctx => {
  const { initId } = ctx;
  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'init:cancelled',
  });
  updateInitOutcome(initId, 'cancelled');
  logInfo('Init cancelled.');
  return null;
};

// ============================================================================
// Full state map
// ============================================================================

export const INIT_STATES: InitStateMap = {
  identify,
  research,
  detect,
  gather_context,
  normalize,
  generate,
  verify,
  promote,
  downgrade_local,
  failed,
  cancelled,
};

export const INIT_TERMINAL_STATES: InitState[] = ['promote', 'downgrade_local', 'failed', 'cancelled'];

// ============================================================================
// Helpers (extracted from scripts.ts for reuse)
// ============================================================================

function detectTicketingTools(): Record<string, string> {
  const tools = [
    { name: 'ClickUp CLI (cup)', cmd: ['cup', '--version'] },
    { name: 'Jira CLI (jira)', cmd: ['jira', '--version'] },
    { name: 'Atlassian CLI (acli)', cmd: ['acli', '--version'] },
    { name: 'go-jira (jira)', cmd: ['jira', 'version'] },
    { name: 'jira-cli (jira)', cmd: ['jira', 'help'] },
    { name: 'GitHub CLI (gh)', cmd: ['gh', '--version'] },
    { name: 'Linear CLI (linear)', cmd: ['linear', '--version'] },
    { name: 'Asana CLI (asana)', cmd: ['asana', '--version'] },
    { name: 'Notion CLI (notion)', cmd: ['notion', '--version'] },
  ];

  const detected: Record<string, string> = {};
  for (const tool of tools) {
    try {
      const proc = Bun.spawnSync({
        cmd: tool.cmd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (proc.exitCode === 0 || proc.exitCode === null) {
        const out = (proc.stdout?.toString().trim() ?? '') || (proc.stderr?.toString().trim() ?? '');
        detected[tool.name] = out.slice(0, 100);
      }
    } catch {
      // Not found
    }
  }

  return detected;
}

/**
 * Build a detection plan derived from the research output and system name (spec section 3.2).
 * Extracts tool names and access methods from the LLM research doc and maps them to
 * concrete detection steps, rather than using a fixed global list.
 */
function buildDetectionPlan(systemName: string, researchDoc: string): ResearchSummary['detectionPlan'] {
  const plan: ResearchSummary['detectionPlan'] = [];
  const doc = researchDoc.toLowerCase();

  // Known tool-to-detection mappings. The research output determines which are included.
  const toolDetections: Array<{
    keywords: string[];
    steps: ResearchSummary['detectionPlan'];
  }> = [
    {
      keywords: ['github', 'gh cli', 'gh '],
      steps: [
        { check: 'gh', type: 'binary', command: 'gh --version' },
        { check: '~/.config/gh/hosts.yml', type: 'config', command: '~/.config/gh/hosts.yml' },
        { check: 'gh', type: 'auth', command: 'gh auth status' },
      ],
    },
    {
      keywords: ['clickup', 'cup'],
      steps: [
        { check: 'cup', type: 'binary', command: 'cup --version' },
        { check: 'cup', type: 'cli_test', command: 'cup me' },
      ],
    },
    {
      keywords: ['jira', 'atlassian'],
      steps: [
        { check: 'jira', type: 'binary', command: 'jira --version' },
        { check: 'acli', type: 'binary', command: 'acli --version' },
        { check: 'jira', type: 'auth', command: 'jira me' },
      ],
    },
    {
      keywords: ['linear'],
      steps: [
        { check: 'linear', type: 'binary', command: 'linear --version' },
        { check: 'linear', type: 'cli_test', command: 'linear whoami' },
      ],
    },
    {
      keywords: ['asana'],
      steps: [{ check: 'asana', type: 'binary', command: 'asana --version' }],
    },
    {
      keywords: ['notion'],
      steps: [{ check: 'notion', type: 'binary', command: 'notion --version' }],
    },
    {
      keywords: ['trello'],
      steps: [{ check: 'trello', type: 'binary', command: 'trello --version' }],
    },
    {
      keywords: ['azure devops', 'azure boards', 'az boards'],
      steps: [
        { check: 'az', type: 'binary', command: 'az --version' },
        { check: 'az', type: 'auth', command: 'az account show' },
      ],
    },
    {
      keywords: ['shortcut', 'clubhouse'],
      steps: [{ check: 'shortcut', type: 'binary', command: 'shortcut --version' }],
    },
  ];

  // Also check system name itself
  const systemLower = systemName.toLowerCase();

  for (const { keywords, steps } of toolDetections) {
    if (keywords.some(k => doc.includes(k) || systemLower.includes(k))) {
      plan.push(...steps);
    }
  }

  // Deduplicate by check+type
  const seen = new Set<string>();
  return plan.filter(step => {
    const key = `${step.check}:${step.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyAccessSetup(answer: string): { needsSetupHelp: boolean; assessment: string } {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) {
    return { needsSetupHelp: true, assessment: 'No access method provided yet.' };
  }

  const setupIndicators = [
    'no',
    'not set up',
    'not setup',
    'not configured',
    'none',
    'broken',
    'idk',
    "i don't know",
    'not logged in',
    'not authenticated',
    'need login',
    'need auth',
    'need setup',
    'not working',
    'installed but',
    'maybe',
    'unsure',
  ];

  const needsSetupHelp = setupIndicators.some(indicator => normalized === indicator || normalized.includes(indicator));
  const assessment = needsSetupHelp
    ? `Access may need setup or verification: ${answer.trim()}`
    : `Access appears ready: ${answer.trim()}`;
  return { needsSetupHelp, assessment };
}

function parseStateMapping(answer: string): { todo: string; inProgress: string; inReview: string } {
  // Try to parse "state1, state2, state3" or "state1 → state2 → state3"
  const parts = answer
    .split(/[,→/]/)
    .map(s => s.trim())
    .filter(Boolean);

  return {
    todo: parts[0] || 'open',
    inProgress: parts[1] || 'in progress',
    inReview: parts[2] || 'review',
  };
}
