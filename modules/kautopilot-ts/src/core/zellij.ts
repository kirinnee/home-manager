/** Zellij session helpers for kautopilot. */

export function zellijSessionName(sessionId: string): string {
  return `kautopilot-${sessionId}`;
}

export function isZellijSessionAlive(sessionId: string): boolean {
  const name = zellijSessionName(sessionId);
  try {
    const result = Bun.spawnSync(['zellij', 'list-sessions', '-n', '-s']);
    if (result.exitCode !== 0) return false;
    const sessions = result.stdout.toString().trim().split('\n').filter(Boolean);
    return sessions.includes(name);
  } catch {
    return false;
  }
}

export function killZellijSession(sessionId: string): boolean {
  const name = zellijSessionName(sessionId);
  try {
    const result = Bun.spawnSync(['zellij', 'kill-session', name]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
