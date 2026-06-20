import { describe, expect, test } from 'bun:test';
import { selectZone } from '../cloudflare';
import { buildIngress, type Route } from '../routes';

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
