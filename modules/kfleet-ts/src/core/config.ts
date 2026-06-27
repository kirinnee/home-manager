// Load and validate ~/.kfleet/config.yaml.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { configPath } from '../deps';
import { type Config, configSchema } from './types';

export function loadConfig(file = configPath): Config {
  if (!existsSync(file)) {
    throw new Error(`no config at ${file} — run "kfleet init" first`);
  }
  const raw = parse(readFileSync(file, 'utf8')) ?? {};
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`invalid config (${file}):\n${issues}`);
  }
  return parsed.data;
}
