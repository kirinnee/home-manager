import { ApiError, TOKEN } from './api';

export interface RuntimeReasoningChoice {
  value: string;
  description?: string;
}

export interface RuntimeModelChoice {
  value: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  reasoningEfforts: RuntimeReasoningChoice[];
  defaultReasoningEffort?: string;
}

export interface RuntimeModelCatalog {
  harness: 'claude' | 'codex';
  source: 'wrapper-inventory' | 'codex-app-server';
  choices: RuntimeModelChoice[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Treat the daemon response as untrusted wire data. Model and effort ids stay
 * opaque and ordered exactly as the harness advertised them. */
export function parseRuntimeModelCatalog(value: unknown): RuntimeModelCatalog {
  const root = object(value);
  const harness = root?.harness;
  const source = root?.source;
  if (
    !root ||
    (harness !== 'claude' && harness !== 'codex') ||
    (source !== 'wrapper-inventory' && source !== 'codex-app-server') ||
    !Array.isArray(root.choices)
  )
    throw new ApiError(502, 'daemon returned an invalid runtime model catalog');

  const choices: RuntimeModelChoice[] = [];
  for (const rawChoice of root.choices) {
    const choice = object(rawChoice);
    const modelValue = string(choice?.value);
    const label = string(choice?.label);
    if (!modelValue || !label || !Array.isArray(choice?.reasoningEfforts))
      throw new ApiError(502, 'daemon returned an invalid runtime model choice');
    const reasoningEfforts: RuntimeReasoningChoice[] = [];
    for (const rawEffort of choice.reasoningEfforts) {
      const effort = object(rawEffort);
      const effortValue = string(effort?.value);
      if (!effortValue) throw new ApiError(502, 'daemon returned an invalid runtime reasoning choice');
      reasoningEfforts.push({
        value: effortValue,
        ...(string(effort?.description) ? { description: string(effort?.description) } : {}),
      });
    }
    choices.push({
      value: modelValue,
      label,
      ...(string(choice.description) ? { description: string(choice.description) } : {}),
      ...(choice.isDefault === true ? { isDefault: true } : {}),
      reasoningEfforts,
      ...(string(choice.defaultReasoningEffort)
        ? { defaultReasoningEffort: string(choice.defaultReasoningEffort) }
        : {}),
    });
  }
  return { harness, source, choices };
}

export function requireRuntimeModelCatalogHarness(
  catalog: RuntimeModelCatalog,
  expected: RuntimeModelCatalog['harness'],
): RuntimeModelCatalog {
  if (catalog.harness !== expected)
    throw new ApiError(502, `daemon returned a ${catalog.harness} model catalog for a ${expected} session`);
  return catalog;
}

/** Session-scoped because the wrapper account, provider and project config all
 * participate in Codex's model/list result. */
export async function fetchRuntimeModelCatalog(
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): Promise<RuntimeModelCatalog> {
  const headers = new Headers();
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  const response = await fetchImpl(`/v1/sessions/${encodeURIComponent(sessionId)}/runtime-models`, { headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.code);
  }
  return parseRuntimeModelCatalog(await response.json());
}
