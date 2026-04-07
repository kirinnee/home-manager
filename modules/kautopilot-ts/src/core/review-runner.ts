import { debugLog, spawnPrintRaw } from '../llm/spawn';
import { MultiSpinner } from '../util/spinner';
import { appendEvent } from './log';
import type { PromptVars } from './type-config';
import { resolveBinary, resolvePromptVars, resolveTimeout } from './type-config';
import type { Config, ReviewerConfig } from './types';

export interface ReviewResult {
  reviewer: string;
  issues: string;
}

/**
 * Run all configured reviewers in parallel, collect results,
 * deduplicate, and return a concise summarized problem list.
 *
 * Stateless — only returns a string, writes nothing.
 */
export async function runReviewers(
  reviewers: Record<string, ReviewerConfig>,
  vars: PromptVars,
  config: Config,
  sessionId?: string,
): Promise<string> {
  const entries = Object.entries(reviewers);
  if (entries.length === 0) return 'No reviewers configured.';

  // Run all reviewers in parallel with multi-spinner
  const ms = new MultiSpinner();
  for (const [name, reviewer] of entries) {
    ms.add(name, `Reviewing: ${reviewer.desc}`);
  }

  const results = await Promise.allSettled(
    entries.map(async ([name, reviewer]) => {
      if (sessionId) {
        appendEvent(sessionId, {
          ts: new Date().toISOString(),
          event: 'subtask:started',
          metadata: { task: name, parent: 'review' },
        });
      }
      const prompt = resolvePromptVars(reviewer.prompt, vars);
      const binary = resolveBinary(reviewer.binaries, config);
      debugLog(`[review] running reviewer "${name}" with binary "${binary}"`);

      try {
        const output = await spawnPrintRaw(binary, prompt, {
          cwd: vars.worktree,
          timeout: resolveTimeout(reviewer.timeout, config),
          sessionId,
          label: `review-${name}`,
        });
        ms.done(name);
        if (sessionId) {
          appendEvent(sessionId, {
            ts: new Date().toISOString(),
            event: 'subtask:completed',
            metadata: { task: name, parent: 'review' },
          });
        }
        return { reviewer: name, issues: output } as ReviewResult;
      } catch (err) {
        ms.fail(name);
        if (sessionId) {
          appendEvent(sessionId, {
            ts: new Date().toISOString(),
            event: 'subtask:failed',
            metadata: { task: name, parent: 'review', error: String(err) },
          });
        }
        throw err;
      }
    }),
  );

  ms.stop();

  // Collect successful results
  const collected: ReviewResult[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.issues.trim()) {
      collected.push(result.value);
    } else if (result.status === 'rejected') {
      debugLog(`[review] reviewer failed: ${result.reason}`);
    }
  }

  if (collected.length === 0) return 'No issues found.';

  // Summarize: deduplicate via LLM
  const summaryInput = collected.map(r => `## ${r.reviewer}\n${r.issues}`).join('\n\n---\n\n');

  const summaryPrompt = `You are a review summarizer. Below are the outputs from multiple independent reviewers analyzing the same document.

Your job:
1. Merge all findings into ONE concise, deduplicated problem list
2. Remove duplicate or overlapping issues
3. Number each unique problem
4. Be concise — one line per problem, no preamble

Reviewer outputs:

${summaryInput}

Output ONLY the numbered problem list. If no real issues, output "No issues found."`;

  const summaryBinary = resolveBinary(undefined, config);
  try {
    const summary = await spawnPrintRaw(summaryBinary, summaryPrompt, {
      cwd: vars.worktree,
      spinnerMsg: 'Summarizing review findings',
      sessionId,
      label: 'review-summarize',
    });
    return summary;
  } catch (err) {
    debugLog(`[review] summarization failed: ${err}`);
    // Fallback: return raw collected issues
    return collected.map(r => `[${r.reviewer}]\n${r.issues}`).join('\n\n');
  }
}
