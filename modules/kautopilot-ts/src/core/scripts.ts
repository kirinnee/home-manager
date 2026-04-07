import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectOption, textInput } from '../llm/inquirer';
import { debugLog, spawnPrintRaw } from '../llm/spawn';
import { logDim, logField, logHeading, logInfo, logOk, logWarn } from '../util/format';
import { renderMarkdown } from '../util/markdown';
import { getAgentPrompt, getDefaultBinary } from './agents';
import { sessionDir } from './artifacts';
import { getCurrentBranch } from './git';

// ============================================================================
// Script constants
// ============================================================================

export const ALL_SCRIPTS = [
  'extract-ticket',
  'get-ticket',
  'start-ticket',
  'to-review',
  'revert-to-inprogress',
  // Expanded ticket script surface (spec section 12)
  'update-ticket',
  'create-downstream-ticket',
  'add-comment',
  'move-to-todo',
  'attach-artifact',
];
export const CRITICAL_SCRIPTS = ['extract-ticket', 'get-ticket'];
export const OPTIONAL_SCRIPTS = [
  'start-ticket',
  'to-review',
  'revert-to-inprogress',
  'update-ticket',
  'create-downstream-ticket',
  'add-comment',
  'move-to-todo',
  'attach-artifact',
];

const NOOP_SCRIPT = '#!/bin/bash\n# no-op\nexit 0\n';

const ORGS_DIR = `${process.env.HOME}/.kautopilot/orgs`;

function classifyAccessSetup(answer: string): {
  needsSetupHelp: boolean;
  assessment: string;
} {
  const trimmed = answer.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) {
    return {
      needsSetupHelp: true,
      assessment: 'No access method provided yet.',
    };
  }

  const setupPatterns = [
    /^no$/,
    /\bnot set ?up\b/,
    /\bnot configured\b/,
    /^none$/,
    /\bbroken\b/,
    /\bidk\b/,
    /\bi don't know\b/,
    /\bnot logged in\b/,
    /\bnot authenticated\b/,
    /\bneed login\b/,
    /\bneed auth(?:entication)?\b/,
    /\bneed setup\b/,
    /\bnot working\b/,
    /\binstalled but\b/,
    /^maybe$/,
    /^unsure$/,
  ];

  const readySignals = [/\bauthenticated\b/, /\bworking\b/, /\buse\b.+\bacli\b/, /\bacli\b/, /\bcli\b/];

  const needsSetupHelp =
    setupPatterns.some(pattern => pattern.test(normalized)) && !readySignals.some(pattern => pattern.test(normalized));
  const assessment = needsSetupHelp
    ? `Access may need setup or verification: ${trimmed}`
    : `Access appears ready: ${trimmed}`;
  return { needsSetupHelp, assessment };
}

// ============================================================================
// Script path resolution
// ============================================================================

// ============================================================================
// Script execution
// ============================================================================

/**
 * Run a session script by name. Returns stdout on success, empty string on failure.
 * Scripts are best-effort — failures are logged but never thrown.
 */
export function runScript(sessionId: string, name: string, args: string[] = []): string {
  return runScriptFromDir(join(sessionDir(sessionId), 'scripts'), name, args).stdout;
}

export interface ScriptResult {
  ok: boolean;
  stdout: string;
}

/**
 * Run a script from a given directory. Returns {ok, stdout} based on exit code.
 * No-op scripts (exit 0, empty stdout) are treated as success.
 */
export function runScriptFromDir(scriptsDir: string, name: string, args: string[] = []): ScriptResult {
  const path = join(scriptsDir, name);
  if (!existsSync(path)) return { ok: false, stdout: '' };

  debugLog(`$ ${path} ${args.join(' ')}`);
  try {
    const proc = Bun.spawnSync({
      cmd: [path, ...args],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout.toString().trim();
    debugLog(`  exit=${proc.exitCode} stdout="${stdout.slice(0, 100)}"`);

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim();
      if (stderr) logWarn(`[scripts] ${name}: ${stderr}`);
      return { ok: false, stdout: '' };
    }

    return { ok: true, stdout };
  } catch (err) {
    logWarn(`[scripts] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, stdout: '' };
  }
}

// ============================================================================
// Org script loading
// ============================================================================

/**
 * Try to copy all 5 scripts from org dir.
 * Returns { found: [...copied], missing: [...not found] }.
 */
export function loadOrgScripts(targetDir: string, org: string): { found: string[]; missing: string[] } {
  mkdirSync(targetDir, { recursive: true });

  const orgDir = join(ORGS_DIR, org);
  const found: string[] = [];
  const missing: string[] = [];

  if (!org || !existsSync(orgDir)) {
    return { found: [], missing: [...ALL_SCRIPTS] };
  }

  for (const name of ALL_SCRIPTS) {
    const src = join(orgDir, name);
    const dest = join(targetDir, name);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      Bun.spawnSync({ cmd: ['chmod', '+x', dest] });
      found.push(name);
    } else {
      missing.push(name);
    }
  }

  if (found.length === ALL_SCRIPTS.length) {
    logField('Scripts', `all copied from org "${org}"`);
  } else if (found.length > 0) {
    logField('Scripts', `copied ${found.length} from org "${org}", missing ${missing.join(', ')}`);
  }

  return { found, missing };
}

// ============================================================================
// Script verification
// ============================================================================

/**
 * Verify critical scripts actually work.
 * Returns { extractTicketId: string | null, getTicketOk: boolean }.
 */
export function verifyCriticalScripts(
  scriptsDir: string,
  branch: string,
): { extractTicketId: string | null; getTicketOk: boolean } {
  const extractScript = join(scriptsDir, 'extract-ticket');
  let extractedId: string | null = null;

  if (existsSync(extractScript)) {
    const proc = Bun.spawnSync({
      cmd: [extractScript],
      stdin: Buffer.from(`${branch}\n`),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout?.toString().trim() ?? '';
    const stderr = proc.stderr?.toString().trim() ?? '';

    debugLog(`extract-ticket input: "${branch}"`);
    debugLog(`extract-ticket exit: ${proc.exitCode}, stdout: "${stdout}"`);
    if (stderr) debugLog(`extract-ticket stderr: ${stderr}`);

    if (proc.exitCode === 0 && stdout.length > 0) {
      extractedId = stdout;
    }
  } else {
    logWarn(`extract-ticket not found at ${extractScript}`);
  }

  // Test get-ticket (only if we got a ticket ID)
  let getTicketOk = false;
  if (extractedId) {
    const result = runScriptFromDir(scriptsDir, 'get-ticket', [extractedId]);
    debugLog(`get-ticket returned ${result.stdout ? `${result.stdout.length} chars` : 'nothing'}`);
    if (result.ok && result.stdout.length > 10) {
      getTicketOk = true;
    }
  }

  return { extractTicketId: extractedId, getTicketOk };
}

/**
 * Display the contents of each script to the user.
 */
export function showScripts(scriptsDir: string, scripts: string[]): void {
  logHeading('Scripts');

  for (const name of scripts) {
    const path = join(scriptsDir, name);
    if (existsSync(path)) {
      console.log(`\n--- ${name} ---`);
      console.log(readFileSync(path, 'utf-8'));
    }
  }

  console.log();
}

// ============================================================================
// LLM script creation
// ============================================================================

/**
 * Check which ticketing CLI tools are available on this system.
 * Returns a map of tool name → detected path/version.
 */
function detectTicketingTools(): Record<string, string> {
  const tools = [
    // ClickUp
    { name: 'ClickUp CLI (cup)', cmd: ['cup', '--version'] },
    // Jira
    { name: 'Jira CLI (jira)', cmd: ['jira', '--version'] },
    { name: 'Atlassian CLI (acli)', cmd: ['acli', '--version'] },
    { name: 'go-jira (jira)', cmd: ['jira', 'version'] },
    { name: 'jira-cli (jira)', cmd: ['jira', 'help'] },
    // GitHub Issues
    { name: 'GitHub CLI (gh)', cmd: ['gh', '--version'] },
    // Linear
    { name: 'Linear CLI (linear)', cmd: ['linear', '--version'] },
    // Asana
    { name: 'Asana CLI (asana)', cmd: ['asana', '--version'] },
    // Notion
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
 * 4-step research-first init flow for ticket integration.
 *
 * Step 1: Free-form "what task system?" → LLM researches it
 * Step 2: "How do you access it?" + check if configured → setup help or proceed
 * Step 3: State mapping (todo/in-progress/review) — no-op if doesn't map
 * Step 4: Context/quirks (defaults, folders, sprints, restrictions)
 *
 * Then: create + verify scripts.
 * Returns false if user wants to fall back to local mode.
 */
export async function promptSetupScripts(
  scriptsDir: string,
  missing: string[],
  _org: string | undefined | null,
  sessionId?: string,
): Promise<boolean> {
  const branch = getCurrentBranch(process.cwd());
  const detected = detectTicketingTools();
  const detectedNames = Object.keys(detected);
  const detectedInfo =
    detectedNames.length > 0 ? detectedNames.map(n => `  - ${n}: ${detected[n]}`).join('\n') : '  (none detected)';

  // ── Step 1: What task system? ──────────────────────────────────────
  logHeading('Ticket System Setup');

  const taskSystem = await textInput(
    'What task/ticket system do you use? (e.g., "ClickUp", "Jira", "GitHub Issues", "Linear", "we use Notion databases", etc.)',
    '',
  );

  if (!taskSystem.trim()) {
    logInfo('No task system specified. Use `kautopilot init --local` instead.');
    return false;
  }

  // Step 1b: LLM researches the system
  logDim('Researching your task system...');
  const researchPrompt = getAgentPrompt('init', 'researchTicketSystem', {
    taskSystem: taskSystem.trim(),
    detectedInfo,
  });

  const researchDoc = await spawnPrintRaw(getDefaultBinary(), researchPrompt, {
    cwd: process.cwd(),
    spinnerMsg: `Researching ${taskSystem.trim()}`,
    sessionId,
    label: 'research-task-system',
  });

  // (research doc kept for context when creating scripts later — not shown to user)

  // ── Step 2: How do you access it? ─────────────────────────────────
  const systemName = taskSystem.trim();
  const toolHint = detectedNames.length > 0 ? ` I detected ${detectedNames.join(', ')} on your system.` : '';
  const accessQuestion = `How do you access your ${systemName} tickets?${toolHint} Is it set up and working?`;
  const accessAnswer = await textInput(accessQuestion, '');
  const accessSetup = classifyAccessSetup(accessAnswer);

  if (accessSetup.needsSetupHelp) {
    // User isn't fully set up — research setup instructions and offer help
    logDim('Researching setup instructions...');
    const setupPrompt = getAgentPrompt('init', 'researchSetup', {
      taskSystem: taskSystem.trim(),
      accessMethod: accessAnswer.trim() || 'unknown',
    });

    const setupInstructions = await spawnPrintRaw(getDefaultBinary(), setupPrompt, {
      cwd: process.cwd(),
      spinnerMsg: 'Researching setup instructions',
      sessionId,
      label: 'research-setup',
    });

    if (setupInstructions) {
      console.log(`\n${renderMarkdown(setupInstructions)}\n`);
    }

    const setupChoice = await selectOption<'done' | 'local'>('What would you like to do?', [
      {
        value: 'done',
        label: 'I have set it up',
        hint: 'Continue with ticket integration',
      },
      {
        value: 'local',
        label: 'Downgrade to local mode',
        hint: 'Skip ticket integration',
      },
    ]);

    if (setupChoice === 'local') {
      logInfo('Use `kautopilot init --local` for future sessions.');
      return false;
    }
  }

  // ── Step 3: State mapping ─────────────────────────────────────────
  console.log(
    renderMarkdown(
      [
        '### Ticket States',
        '',
        'Please provide the state names from your ticket system:',
        '',
        '- **TODO/Backlog** — e.g. `open`, `to do`, `backlog`',
        '- **In-progress** — e.g. `in progress`, `active`, `doing`',
        '- **In-review** — e.g. `review`, `in review`, `ready for review`',
        '',
        'If this doesn\'t map well, say "doesn\'t map" and transitions will be no-ops.',
      ].join('\n'),
    ),
  );
  const stateAnswer = await textInput(
    'Enter your ticket states (todo, in-progress, in-review):',
    'e.g. open, in progress, review',
  );

  const transitionNoOp = /doesn'?t map|doesn'?t apply|no\s*op|skip|n\/a|none/i.test(stateAnswer.trim());

  // ── Step 4: Context & quirks ──────────────────────────────────────
  const quirks = await textInput(
    'Any defaults, context, or quirks? (e.g., "always use project X", "only Sprint folder", ' +
      '"tickets must go through Triage first", "custom field for priority"). Leave blank if none.',
    '',
  );

  // ── Create scripts ────────────────────────────────────────────────
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

  const scriptsToCreate = transitionNoOp
    ? missing.filter(s => CRITICAL_SCRIPTS.includes(s)) // Only create critical scripts
    : missing;

  // Build variable substitution values for the createScripts prompt template
  const scriptList = scriptsToCreate.map(s => `- ${s}: ${scriptInterfaces[s]}`).join('\n');
  const optionalScriptsSection =
    transitionNoOp && missing.some(s => OPTIONAL_SCRIPTS.includes(s))
      ? '\nThese transition scripts should be NO-OPS:\n' +
        missing
          .filter(s => OPTIONAL_SCRIPTS.includes(s))
          .map(s => `- ${s}: #!/bin/bash\n# no-op (state mapping not applicable)\nexit 0`)
          .join('\n')
      : '';
  const quirksSection = quirks.trim() ? `Context/quirks: ${quirks.trim()}` : '';
  const transitionNoOpSection = transitionNoOp
    ? 'NOTE: Transition scripts should be NO-OPS (exit 0). User says states do not map well.'
    : '';

  const prompt = getAgentPrompt('init', 'createScripts', {
    taskSystem: taskSystem.trim(),
    accessMethod: accessAnswer.trim(),
    stateMapping: stateAnswer.trim(),
    transitionNoOp: transitionNoOpSection,
    branch,
    scriptsDir,
    quirks: quirksSection,
    setupAssessment: accessSetup.assessment,
    researchDoc: researchDoc || '(no research available)',
    detectedInfo,
    scriptList,
    optionalScripts: optionalScriptsSection,
  });

  // Spawn Claude to create + test scripts
  const llmOutput = await spawnPrintRaw(getDefaultBinary(), prompt, {
    cwd: process.cwd(),
    spinnerMsg: `Creating ${taskSystem.trim()} integration scripts`,
    sessionId,
    label: 'create-scripts',
  });
  if (llmOutput) {
    console.log(renderMarkdown(llmOutput));
    console.log();
  }

  // Create no-op transition scripts if user said states don't map
  if (transitionNoOp) {
    for (const name of OPTIONAL_SCRIPTS) {
      if (missing.includes(name)) {
        const dest = join(scriptsDir, name);
        writeFileSync(dest, NOOP_SCRIPT);
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

  // Verify critical scripts
  const result = verifyCriticalScripts(scriptsDir, branch);

  if (!result.extractTicketId) {
    logWarn('extract-ticket did not return a valid ticket ID.');
  }
  if (!result.getTicketOk) {
    logWarn('get-ticket did not return usable content.');
  }

  // Retry loop for critical scripts
  while (!result.extractTicketId || !result.getTicketOk) {
    logWarn('Critical scripts are not working correctly.');
    const fix = await selectOption<'retry' | 'regenerate' | 'local'>('What would you like to do?', [
      {
        value: 'retry',
        label: 'Retry verify',
        hint: 'Fix your tool/auth, then we verify again',
      },
      {
        value: 'regenerate',
        label: 'Regenerate scripts',
        hint: 'LLM tries again from scratch',
      },
      {
        value: 'local',
        label: 'Use local mode',
        hint: 'Skip ticket integration',
      },
    ]);

    if (fix === 'local') {
      logInfo('Use `kautopilot init --local` instead.');
      return false;
    }

    if (fix === 'regenerate') {
      const regenOutput = await spawnPrintRaw(getDefaultBinary(), prompt, {
        cwd: process.cwd(),
        spinnerMsg: `Regenerating ${taskSystem.trim()} scripts`,
        sessionId,
        label: 'regenerate-scripts',
      });
      if (regenOutput) {
        console.log(renderMarkdown(regenOutput));
        console.log();
      }
    }

    if (fix === 'retry') {
      logDim('Fix your tool/config, then press Enter to re-verify.');
      await textInput('Press Enter when ready to re-verify...', '');
    }

    const retry = verifyCriticalScripts(scriptsDir, branch);
    Object.assign(result, retry);
  }

  // Show created scripts
  showScripts(scriptsDir, missing);
  return true;
}

// ============================================================================
// Org save
// ============================================================================

/**
 * Ask user whether to save scripts and config as org config for future projects.
 */
export async function promptSaveOrg(
  scriptsDir: string,
  org: string | undefined | null,
  sessionId?: string,
): Promise<void> {
  if (!org) return;
  const { confirmAction } = await import('../llm/inquirer');
  const save = await confirmAction(
    `Save these scripts and config as org config for "${org}"? Future projects will reuse them.`,
    true,
  );
  if (!save) return;

  const orgDir = join(ORGS_DIR, org);
  mkdirSync(orgDir, { recursive: true });

  for (const name of ALL_SCRIPTS) {
    const src = join(scriptsDir, name);
    const dest = join(orgDir, name);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }

  // Copy session config to org if available
  if (sessionId) {
    const sDir = sessionDir(sessionId);
    const sessionConfig = join(sDir, 'config.yaml');
    if (existsSync(sessionConfig)) {
      copyFileSync(sessionConfig, join(orgDir, 'config.yaml'));
    }
  }

  logOk(`Org scripts and config saved to ${orgDir}`);
}
