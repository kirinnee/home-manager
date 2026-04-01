import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Phase1Context } from './types';
import { appendEvent } from '../../core/log';
import { snapshotPath, ensureArtifactDir } from '../../core/artifacts';
import { getTypeDescriptions, getTypeConfig } from '../../core/type-config';
import { spawnPrint, debugLog } from '../../llm/spawn';
import { getDefaultBinary, getAgentPrompt } from '../../core/agents';
import { logOk, logError } from '../../util/format';

interface RouteResult {
  type: string;
}

/**
 * [llm] Classify the ticket into a type using LLM.
 * Writes type.json to session artifacts.
 */
export async function handleRouteType(ctx: Phase1Context): Promise<string | null> {
  const { session, config, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'route_type:started',
    version,
    metadata: { stepType: 'llm' },
  });

  const types = getTypeDescriptions(config);
  if (types.length === 0) {
    logError('No types configured. Add a `types` section to your config.yaml.');
    throw new Error('No types configured');
  }

  // Read ticket content
  const ticketPath = join(session.worktree, 'spec', 'ticket.md');
  let ticketContent = '';
  if (existsSync(ticketPath)) {
    ticketContent = readFileSync(ticketPath, 'utf-8');
  }

  // Build routing prompt
  const typeList = types.map(t => `- "${t.name}": ${t.desc}`).join('\n');

  const prompt = getAgentPrompt('init', 'routeType', {
    typeList,
    ticketContent: ticketContent || '(no ticket content available — local mode)',
  });

  const binary = getDefaultBinary();
  let typeName: string;

  // If only one type is configured, skip LLM call
  if (types.length === 1) {
    typeName = types[0].name;
    debugLog(`[route_type] single type configured, using "${typeName}"`);
  } else {
    const result = await spawnPrint<RouteResult>(binary, prompt, {
      cwd: session.worktree,
      spinnerMsg: 'Classifying ticket type',
      sessionId: session.id,
      label: 'route-type',
    });
    typeName = result.type;
  }

  // Validate the type exists in config
  const typeConfig = getTypeConfig(config, typeName);
  if (!typeConfig) {
    // Fallback to first type
    typeName = types[0].name;
    debugLog(`[route_type] LLM returned unknown type, falling back to "${typeName}"`);
  }

  // Write type.json to artifacts
  const typeJson = { type: typeName, desc: config.types[typeName].desc };
  const typeJsonPath = snapshotPath(session.id, version, 'type.json');
  ensureArtifactDir(typeJsonPath);
  writeFileSync(typeJsonPath, JSON.stringify(typeJson, null, 2));

  // Store on context for downstream handlers
  ctx.ticketType = typeName;
  ctx.typeConfig = config.types[typeName];

  // Persist to WAL for status materialization
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { ticketType: typeName },
  });

  logOk(`Ticket type: ${typeName} — ${config.types[typeName].desc}`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'route_type:completed',
    version,
    metadata: { type: typeName },
  });

  return 'write_spec';
}
