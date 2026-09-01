import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { qaEnvironment, rootDir } from './env';

const execFileAsync = promisify(execFile);

export const QA_PASSWORD = 'GenieQa!2026';

export async function seedScenario(scenario: string): Promise<void> {
  await execFileAsync('pnpm', ['qa:seed', scenario], {
    cwd: rootDir,
    env: { ...process.env, ...qaEnvironment },
    maxBuffer: 2 * 1024 * 1024,
  });
}

export function qaEmail(scenario: string): string {
  return `qa-${scenario}@maildrop.cc`;
}
