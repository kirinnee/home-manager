import { describe, expect, test } from 'bun:test';
import { selectZone } from '../cloudflare';
import { resolveMachineId } from '../config';
import { buildIngress, expandMachine, type Route } from '../routes';

const route = (hostname: string, service: string): Route => ({ hostname, service, access: true });

describe('buildIngress', () => {
  const routes = [
    route('kauto.ernest.atomi.cloud', 'http://localhost:47317'),
    route('ssh.ernest.atomi.cloud', 'ssh://localhost:22'),
  ];

  test('maps routes to ingress and always ends with the catch-all', () => {
    const ingress = buildIngress(routes, [], false);
    expect(ingress).toEqual([
      { hostname: 'kauto.ernest.atomi.cloud', service: 'http://localhost:47317' },
      { hostname: 'ssh.ernest.atomi.cloud', service: 'ssh://localhost:22' },
      { service: 'http_status:404' },
    ]);
  });

  test('preserves an un-managed manual rule when not pruning', () => {
    const existing = [
      { hostname: 'manual.atomi.cloud', service: 'http://localhost:9000' },
      { service: 'http_status:404' },
    ];
    const ingress = buildIngress(routes, existing, false);
    expect(ingress.find(i => i.hostname === 'manual.atomi.cloud')).toBeDefined();
    expect(ingress.filter(i => i.service === 'http_status:404')).toHaveLength(1);
    expect(ingress[ingress.length - 1]).toEqual({ service: 'http_status:404' });
  });

  test('drops manual rules when pruning', () => {
    const existing = [{ hostname: 'manual.atomi.cloud', service: 'http://localhost:9000' }];
    const ingress = buildIngress(routes, existing, true);
    expect(ingress.find(i => i.hostname === 'manual.atomi.cloud')).toBeUndefined();
  });

  test('does not duplicate a route already present in existing ingress', () => {
    const existing = [{ hostname: 'kauto.ernest.atomi.cloud', service: 'http://localhost:1' }];
    const ingress = buildIngress(routes, existing, false);
    expect(ingress.filter(i => i.hostname === 'kauto.ernest.atomi.cloud')).toHaveLength(1);
  });
});

describe('expandMachine', () => {
  test('replaces the {machine} token with the machine id', () => {
    const routes = [
      route('kauto.{machine}.ernest.atomi.cloud', 'http://localhost:47317'),
      route('kloop.{machine}.ernest.atomi.cloud', 'http://localhost:47316'),
    ];
    expect(expandMachine(routes, 'lombp').map(r => r.hostname)).toEqual([
      'kauto.lombp.ernest.atomi.cloud',
      'kloop.lombp.ernest.atomi.cloud',
    ]);
  });

  test('replaces every occurrence and leaves token-free hostnames untouched', () => {
    const routes = [
      route('{machine}.{machine}.atomi.cloud', 'http://localhost:1'),
      route('ssh.ernest.atomi.cloud', 'ssh://localhost:22'),
    ];
    const out = expandMachine(routes, 'box');
    expect(out[0].hostname).toBe('box.box.atomi.cloud');
    expect(out[1].hostname).toBe('ssh.ernest.atomi.cloud');
  });

  test('preserves the other route fields', () => {
    const out = expandMachine([{ hostname: '{machine}.x', service: 'ssh://localhost:22', access: false }], 'm');
    expect(out[0]).toEqual({ hostname: 'm.x', service: 'ssh://localhost:22', access: false });
  });
});

describe('resolveMachineId', () => {
  test('uses the configured machine name when set', () => {
    expect(resolveMachineId('lombp', 'some-host')).toBe('lombp');
    expect(resolveMachineId('Lom BP!', 'some-host')).toBe('lom-bp');
  });

  test('falls back to a DNS-safe label from the short hostname', () => {
    expect(resolveMachineId(undefined, 'Box-01.local')).toBe('box-01');
    expect(resolveMachineId('', 'AMER-D22HXVF42W')).toBe('amer-d22hxvf42w');
  });

  test('falls back to "host" when nothing resolves', () => {
    expect(resolveMachineId(undefined, '')).toBe('host');
    expect(resolveMachineId('...', '...')).toBe('host');
  });
});

describe('selectZone', () => {
  const zones = [{ name: 'atomi.cloud' }, { name: 'ernest.atomi.cloud' }, { name: 'other.com' }];

  test('picks the longest matching suffix', () => {
    expect(selectZone('kauto.ernest.atomi.cloud', zones)?.name).toBe('ernest.atomi.cloud');
  });

  test('matches a parent zone when no deeper zone exists', () => {
    expect(selectZone('foo.atomi.cloud', zones)?.name).toBe('atomi.cloud');
  });

  test('matches an exact zone name', () => {
    expect(selectZone('other.com', zones)?.name).toBe('other.com');
  });

  test('returns undefined when nothing matches', () => {
    expect(selectZone('nope.example.org', zones)).toBeUndefined();
  });
});
