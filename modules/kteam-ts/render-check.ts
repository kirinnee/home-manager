import { renderWrapper } from './src/core/generate';
const script = renderWrapper({
  name: 'auto-loge',
  kind: 'claude',
  base: 'loge',
  variant: 'auto',
  env: { ANTHROPIC_API_KEY: 'loge-internal' },
} as any);
await Bun.write(
  '/tmp/claude-1000/-home-kirin--config-home-manager/9876aa2c-1a10-4cc3-8800-9519202459b9/scratchpad/wrapper.sh',
  script,
);
console.log(script.split('\n').slice(-20).join('\n'));
