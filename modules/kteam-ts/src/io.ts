import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

export const now = () => new Date().toISOString();

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function run(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { ...options, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
