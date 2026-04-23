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
    const kill = Bun.spawnSync(['zellij', 'kill-session', name]);
    if (kill.exitCode === 0) return true;
    // Session may be EXITED (serialized) — needs delete-session instead
    const del = Bun.spawnSync(['zellij', 'delete-session', name]);
    return del.exitCode === 0;
  } catch {
    return false;
  }
}
