const FRAMES = ['◒', '◐', '◓', '◑'];
const INTERVAL = 80;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

const isTTY = process.stdout.isTTY;

const c = {
  reset: isTTY ? '\x1b[0m' : '',
  green: isTTY ? '\x1b[32m' : '',
  red: isTTY ? '\x1b[31m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  clearLine: isTTY ? '\x1b[2K' : '',
  cursorUp: (n: number) => (isTTY ? `\x1b[${n}A` : ''),
};

interface SpinnerTask {
  id: string;
  msg: string;
  state: 'spinning' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Multi-line spinner for tracking parallel sub-agents.
 * Each task gets its own line with an independent spinning indicator.
 * No-op when stdout is not a TTY.
 */
export class MultiSpinner {
  private tasks: SpinnerTask[] = [];
  private frameIdx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rendered = false;
  private maxMsgLen = 0;

  add(id: string, msg: string): void {
    this.tasks.push({ id, msg, state: 'spinning', startedAt: Date.now(), finishedAt: null });
    if (msg.length > this.maxMsgLen) this.maxMsgLen = msg.length;
    if (isTTY && !this.timer) {
      this.startTimer();
    }
    this.render();
  }

  done(id: string): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      task.state = 'done';
      task.finishedAt = Date.now();
    }
    this.render();
    this.checkAllDone();
  }

  fail(id: string): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      task.state = 'failed';
      task.finishedAt = Date.now();
    }
    this.render();
    this.checkAllDone();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final render to show completed state
    this.render();
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length;
      this.render();
    }, INTERVAL);
  }

  private checkAllDone(): void {
    if (this.tasks.every(t => t.state !== 'spinning')) {
      this.stop();
    }
  }

  private render(): void {
    if (!isTTY) return;

    // Move cursor up to overwrite previous render
    if (this.rendered) {
      process.stdout.write(c.cursorUp(this.tasks.length));
    }

    const cols = process.stdout.columns || 80;
    const now = Date.now();
    const frame = FRAMES[this.frameIdx];
    for (const task of this.tasks) {
      let prefix: string;
      switch (task.state) {
        case 'done':
          prefix = `${c.green}✓${c.reset}`;
          break;
        case 'failed':
          prefix = `${c.red}✗${c.reset}`;
          break;
        default:
          prefix = `${c.dim}${frame}${c.reset}`;
      }
      const elapsed = (task.finishedAt ?? now) - task.startedAt;
      const timeStr = formatElapsed(elapsed).padStart(8);
      // "X  msg  12s" → prefix(1) + 2 + msg + 2 + time(8) = 13 + msg
      const maxMsg = cols - 13;
      let msg = task.msg;
      if (maxMsg > 4 && msg.length > maxMsg) {
        msg = msg.slice(0, maxMsg - 1) + '…';
      }
      const padded = msg.padEnd(Math.min(this.maxMsgLen, maxMsg > 0 ? maxMsg : this.maxMsgLen));
      const time = `${c.dim}${timeStr}${c.reset}`;
      process.stdout.write(`${c.clearLine}\r${prefix}  ${padded}  ${time}\n`);
    }

    this.rendered = true;
  }
}
