import type { Verdict, VerdictFile } from '../types';

// ============================================================================
// Pure: parse verdict from file or text
// ============================================================================

export interface VerdictParseResult {
  verdict: Verdict | null;
  reasoning: string;
  completionEstimate?: number;
}

/**
 * Parse verdict from verdict file content: { approved: true/false, reasoning, completionEstimate? }
 */
export function parseVerdictFile(content: string): VerdictParseResult {
  try {
    const parsed = JSON.parse(content) as VerdictFile;

    if (typeof parsed.approved === 'boolean') {
      return {
        verdict: parsed.approved ? 'approved' : 'rejected',
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
 * Parse verdict from review text content (fallback)
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
