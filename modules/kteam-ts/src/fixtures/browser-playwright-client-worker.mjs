import { createInterface } from 'node:readline';

const mode = process.argv[2];
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === 'fatal') {
  write({ type: 'fatal', error: 'fixture could not connect' });
  process.exit(19);
}
if (mode === 'exit-before-ready') process.exit(0);

let viewport = { width: 1280, height: 800 };
write({ type: 'ready' });
if (mode === 'exit-after-ready') setTimeout(() => process.exit(23), 25);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'crash') process.exit(23);
  if (message.method === 'resize') viewport = message.params;
  const identity = { url: 'https://fixture.test/', title: `${viewport.width}x${viewport.height}` };
  const result =
    message.method === 'read'
      ? { ...identity, text: 'fixture text' }
      : message.method === 'screenshot'
        ? { ...identity, screenshotBase64: 'cG5n' }
        : identity;
  if (mode === 'frames' && message.method === 'location') {
    write({
      type: 'screencast-frame',
      dataBase64: Buffer.from('jpeg').toString('base64'),
      width: viewport.width,
      height: viewport.height,
    });
  }
  write({ id: message.id, ok: true, result });
  if (message.method === 'close') process.exit(0);
});
