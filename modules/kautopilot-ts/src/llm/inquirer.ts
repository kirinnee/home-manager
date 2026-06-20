import * as p from '@clack/prompts';

export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  const result = await p.confirm({ message, initialValue: defaultValue });
  if (p.isCancel(result)) {
    process.exit(0);
  }
  return result;
}
