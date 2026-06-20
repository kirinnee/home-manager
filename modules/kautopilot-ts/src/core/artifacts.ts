export function sessionDir(id: string): string {
  return `${process.env.HOME}/.kautopilot/${id}`;
}
