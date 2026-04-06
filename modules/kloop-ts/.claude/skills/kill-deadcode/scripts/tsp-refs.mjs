#!/usr/bin/env node
/**
 * tsp-refs.mjs — Query TypeScript Language Server for reference count at a position.
 *
 * Usage: node tsp-refs.mjs <file> <line> <col> [--project-root PATH]
 *
 * - file: relative path from project root
 * - line: 1-based line number
 * - col: 1-based column number
 *
 * Outputs a single JSON object to stdout:
 *   { "references": N, "locations": [{ "file": "...", "line": N }] }
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Parse args ---
const args = process.argv.slice(2);

if (args.length < 3 || args[0] === '--help') {
  console.error('Usage: node tsp-refs.mjs <file> <line> <col> [--project-root PATH]');
  process.exit(1);
}

const filePath = args[0];
const line = parseInt(args[1], 10);
const col = parseInt(args[2], 10);

let projectRoot = '';
for (let i = 3; i < args.length; i++) {
  if (args[i] === '--project-root' && args[i + 1]) {
    projectRoot = resolve(args[i + 1]);
    i++;
  }
}

if (!projectRoot) {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(resolve(dir, 'package.json'));
      projectRoot = dir;
      break;
    } catch {
      dir = resolve(dir, '..');
    }
  }
}

if (!projectRoot) {
  console.error('Could not find project root. Use --project-root PATH');
  process.exit(1);
}

// --- LSP Communication ---

const absPath = resolve(projectRoot, filePath);
const fileUri = 'file://' + absPath;

let fileText;
try {
  fileText = readFileSync(absPath, 'utf-8');
} catch (err) {
  console.error('Cannot read file: ' + err.message);
  process.exit(1);
}

const lspBin = resolve(projectRoot, 'node_modules/.bin/typescript-language-server');

const proc = spawn(lspBin, ['--stdio'], {
  cwd: projectRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let messageId = 0;
const pendingHandlers = new Map();

proc.stdout.on('data', chunk => {
  buffer += chunk.toString('utf-8');
  processBuffer();
});

proc.stderr.on('data', () => {});

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const headerStr = buffer.substring(0, headerEnd);
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (buffer.length < bodyEnd) break;

    const body = buffer.substring(bodyStart, bodyEnd);
    buffer = buffer.substring(bodyEnd);

    try {
      const msg = JSON.parse(body);
      if (msg.id !== undefined && pendingHandlers.has(msg.id)) {
        const handler = pendingHandlers.get(msg.id);
        clearTimeout(handler.timer);
        pendingHandlers.delete(msg.id);
        handler.resolve(msg);
      }
    } catch {
      // Skip malformed
    }
  }
}

function send(msg) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(msg);
    const header = 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n';
    proc.stdin.write(header + body, err => {
      if (err) rej(err);
      else res();
    });
  });
}

function request(method, params, timeoutMs = 15000) {
  return new Promise(async (res, rej) => {
    const id = messageId++;
    const timer = setTimeout(() => {
      pendingHandlers.delete(id);
      rej(new Error('Timeout: ' + method));
    }, timeoutMs);

    pendingHandlers.set(id, { resolve: res, timer });

    try {
      await send({ jsonrpc: '2.0', id, method, params });
    } catch (err) {
      clearTimeout(timer);
      pendingHandlers.delete(id);
      rej(err);
    }
  });
}

async function main() {
  try {
    await request(
      'initialize',
      {
        processId: process.pid,
        rootPath: projectRoot,
        rootUri: 'file://' + projectRoot,
        capabilities: {},
      },
      30000,
    );

    await send({ jsonrpc: '2.0', method: 'initialized', params: {} });

    await send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: fileUri,
          languageId: 'typescript',
          version: 1,
          text: fileText,
        },
      },
    });

    await new Promise(r => setTimeout(r, 2000));

    const response = await request(
      'textDocument/references',
      {
        textDocument: { uri: fileUri },
        position: { line: Math.max(0, line - 1), character: Math.max(0, col - 1) },
        context: { includeDeclaration: true },
      },
      10000,
    );

    const locations = response?.result || [];
    const result = {
      references: locations.length,
      locations: locations.map(loc => ({
        file: (loc.uri || '').replace('file://' + projectRoot + '/', ''),
        line: loc.range?.start?.line != null ? loc.range.start.line + 1 : undefined,
      })),
    };

    try {
      await request('shutdown', undefined, 5000);
    } catch {}
    try {
      await send({ jsonrpc: '2.0', method: 'exit' });
    } catch {}

    console.log(JSON.stringify(result));
  } catch (err) {
    console.error('LSP error: ' + err.message);
    process.exit(1);
  } finally {
    setTimeout(() => proc.kill('SIGKILL'), 3000);
  }
}

main();
