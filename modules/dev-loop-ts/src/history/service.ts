import type { HistoryEntry } from '../types';
import type { FsService, Paths, HistoryService } from '../deps';
import { parseHistoryEntry } from '../types';
import * as fmt from './format';

export class HistoryServiceImpl implements HistoryService {
  constructor(
    private fs: FsService,
    private paths: Paths,
  ) {}

  async list(): Promise<HistoryEntry[]> {
    if (!(await this.fs.exists(this.paths.historyDir))) return [];

    const files = await this.fs.readdir(this.paths.historyDir);
    const entries: HistoryEntry[] = [];

    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await this.fs.readFile(`${this.paths.historyDir}/${file}`);
        entries.push(parseHistoryEntry(JSON.parse(content)));
      } catch (err) {
        if (process.env.DEBUG) console.error(`Failed to parse history ${file}:`, err);
      }
    }

    return entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  async load(runId: string): Promise<HistoryEntry | null> {
    const entryPath = this.paths.historyEntry(runId);
    if (!(await this.fs.exists(entryPath))) return null;

    try {
      const content = await this.fs.readFile(entryPath);
      return parseHistoryEntry(JSON.parse(content));
    } catch (err) {
      if (process.env.DEBUG) console.error(`Failed to load history ${runId}:`, err);
      return null;
    }
  }

  format(entry: HistoryEntry): string {
    return fmt.formatHistoryEntry(entry);
  }

  formatList(entries: HistoryEntry[]): string {
    return fmt.formatHistoryList(entries);
  }

  async clear(): Promise<void> {
    if (!(await this.fs.exists(this.paths.historyDir))) return;

    const files = await this.fs.readdir(this.paths.historyDir);
    for (const file of files.filter(f => f.endsWith('.json'))) {
      await this.fs.unlink(`${this.paths.historyDir}/${file}`);
    }
  }
}

export function createHistoryService(fs: FsService, paths: Paths): HistoryService {
  return new HistoryServiceImpl(fs, paths);
}
