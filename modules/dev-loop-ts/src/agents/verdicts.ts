import type { Verdict, VerdictFile } from '../types';

// ============================================================================
// Pure: parse verdict from text
// ============================================================================

export interface VerdictParseResult {
  verdict: Verdict | null;
  reasoning: string;
  completionEstimate?: number;
}

/**
 * Parse verdict from verdict file content
 */
export function parseVerdictFile(content: string): VerdictParseResult {
  try {
    const parsed = JSON.parse(content) as VerdictFile;

    if (parsed.verdict === 'approved' || parsed.verdict === 'rejected') {
      return {
        verdict: parsed.verdict,
        reasoning: parsed.reasoning ?? '',
        completionEstimate: parsed.completionEstimate,
      };
    }

    return { verdict: null, reasoning: '' };
  } catch {
    return { verdict: null, reasoning: '' };
  }
}

/**
 * Parse verdict from text content (fallback)
 */
export function parseVerdictFromText(text: string): Verdict | null {
  const upper = text.toUpperCase().trim();

  if (upper.includes('APPROVED')) {
    return 'approved';
  }

  if (upper.includes('REJECTED')) {
    return 'rejected';
  }

  return null;
}

/**
 * Determine verdict from session result
 */
export function determineVerdict(params: {
  verdictFileContent: string | null;
  reviewFileContent: string | null;
  exitCode: number;
  timedOut: boolean;
}): Verdict {
  const { verdictFileContent, reviewFileContent, exitCode, timedOut } = params;

  // Timeout counts as rejection
  if (timedOut) {
    return 'rejected';
  }

  // Non-zero exit code is rejection
  if (exitCode !== 0) {
    return 'rejected';
  }

  // Try to parse verdict file first
  if (verdictFileContent) {
    const parsed = parseVerdictFile(verdictFileContent);
    if (parsed.verdict) {
      return parsed.verdict;
    }
  }

  // Fallback to parsing review file
  if (reviewFileContent) {
    const fromText = parseVerdictFromText(reviewFileContent);
    if (fromText) {
      return fromText;
    }
  }

  // No clear verdict - treat as rejection
  return 'rejected';
}

/**
 * Create a verdict file object
 */
export function createVerdictFile(verdict: Verdict, reasoning: string): VerdictFile {
  return { verdict, reasoning };
}

/**
 * Stringify verdict file for writing
 */
export function stringifyVerdictFile(verdict: VerdictFile): string {
  return JSON.stringify(verdict, null, 2);
}
