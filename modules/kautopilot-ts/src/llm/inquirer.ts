import * as p from '@clack/prompts';

// ============================================================================
// Turn updater — set by phase runners so prompts update userTurn in status.yaml
// ============================================================================

let turnUpdater: ((userTurn: boolean) => void) | null = null;

export function setTurnUpdater(fn: ((userTurn: boolean) => void) | null): void {
  turnUpdater = fn;
}

export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  turnUpdater?.(true);
  try {
    const result = await p.confirm({ message, initialValue: defaultValue });
    if (p.isCancel(result)) {
      process.exit(0);
    }
    return result;
  } finally {
    turnUpdater?.(false);
  }
}

export async function selectOption<T extends string>(
  message: string,
  options: Array<{ value: T; label: string; hint?: string }>,
): Promise<T> {
  turnUpdater?.(true);
  try {
    const result = await p.select<T>({
      message,
      options: options as { value: T; label?: string; hint?: string }[],
    } as p.SelectOptions<T>);
    if (p.isCancel(result) || typeof result !== 'string') {
      process.exit(0);
    }
    return result as T;
  } finally {
    turnUpdater?.(false);
  }
}

export async function textInput(message: string, placeholder?: string): Promise<string> {
  turnUpdater?.(true);
  try {
    const result = await p.text({ message, placeholder });
    if (p.isCancel(result)) {
      process.exit(0);
    }
    return result;
  } finally {
    turnUpdater?.(false);
  }
}
