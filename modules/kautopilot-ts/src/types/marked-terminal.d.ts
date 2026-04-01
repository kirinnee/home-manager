declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';
  export default function markedTerminal(options?: Record<string, unknown>): MarkedExtension;
}
