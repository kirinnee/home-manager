import * as p from '@clack/prompts';

export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  const result = await p.confirm({ message, initialValue: defaultValue });
  if (p.isCancel(result)) {
    process.exit(0);
  }
  return result;
}

export async function selectOption<T extends string>(
  message: string,
  options: Array<{ value: T; label: string; hint?: string }>,
): Promise<T> {
  const result = await p.select<T>({
    message,
    options: options as { value: T; label?: string; hint?: string }[],
  } as p.SelectOptions<T>);
  if (p.isCancel(result) || typeof result !== 'string') {
    process.exit(0);
  }
  return result as T;
}

export async function textInput(message: string, placeholder?: string): Promise<string> {
  const result = await p.text({ message, placeholder });
  if (p.isCancel(result)) {
    process.exit(0);
  }
  return result;
}

export async function triageIssues(
  issues: string[],
): Promise<{ valid: string[]; invalid: string[]; discuss: string[] }> {
  const valid: string[] = [];
  const invalid: string[] = [];
  const discuss: string[] = [];

  for (const issue of issues) {
    const action = await selectOption<'accept' | 'reject' | 'discuss'>(`Issue: ${issue}`, [
      { value: 'accept', label: 'Accept (valid)', hint: 'Mark as valid issue' },
      { value: 'reject', label: 'Reject (invalid)', hint: 'Mark as invalid, will be ignored' },
      { value: 'discuss', label: 'Discuss', hint: 'Flag for further discussion' },
    ]);
    switch (action) {
      case 'accept':
        valid.push(issue);
        break;
      case 'reject':
        invalid.push(issue);
        break;
      case 'discuss':
        discuss.push(issue);
        break;
    }
  }

  return { valid, invalid, discuss };
}
