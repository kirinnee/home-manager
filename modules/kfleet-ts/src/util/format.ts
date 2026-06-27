import pc from 'picocolors';

export const logInfo = (m: string): void => console.log(`${pc.blue('•')} ${m}`);
export const logOk = (m: string): void => console.log(`${pc.green('✓')} ${m}`);
export const logWarn = (m: string): void => console.log(`${pc.yellow('!')} ${m}`);
const logErr = (m: string): void => console.error(`${pc.red('✗')} ${m}`);
export const logDim = (m: string): void => console.log(pc.dim(m));

export function die(m: string): never {
  logErr(m);
  process.exit(1);
}
