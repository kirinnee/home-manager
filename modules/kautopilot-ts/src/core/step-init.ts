import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifactPath } from './artifacts';
import { stringify as stringifyYaml } from 'yaml';

export type ExecutionType = 'tty_handoff' | 'llm_print' | 'command' | 'inquirer';

export interface StepInitRecord {
  prompt: string;
  command: string;
  type: ExecutionType;
}

/**
 * Write a step init.yaml recording the exact prompt, command, and execution type.
 * Path: ~/.kautopilot/{id}/artifacts/v{N}/steps/{stepName}.yaml
 */
export function writeStepInit(sessionId: string, version: number, stepName: string, record: StepInitRecord): void {
  const path = artifactPath(sessionId, version, 'steps', `${stepName}.yaml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(record));
}
