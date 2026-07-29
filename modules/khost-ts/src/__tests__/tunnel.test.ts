import { describe, expect, test } from 'bun:test';
import { cfdPlist } from '../tunnel';

describe('cfdPlist', () => {
  test('places tunnel run parameters before the run subcommand', () => {
    const plist = cfdPlist('/bin/cloudflared', 'test-token', 'http2');
    const programArguments = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    const args = [...(programArguments ?? '').matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1]);

    expect(args).toEqual(['/bin/cloudflared', 'tunnel', '--protocol', 'http2', 'run', '--token', 'test-token']);
  });
});
