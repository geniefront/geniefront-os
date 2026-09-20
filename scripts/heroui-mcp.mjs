// Credentials belong in the user's private configuration, never in this repository.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const channel = process.argv[2] ?? 'react';
if (!['react', 'native'].includes(channel)) throw new Error('Expected react or native');
let token = process.env.HEROUI_PERSONAL_TOKEN;
if (!token) {
  try { token = JSON.parse(readFileSync(join(homedir(), '.config/geniefront/heroui/credentials.json'), 'utf8')).PERSONAL_TOKEN; }
  catch { /* Emit no file contents or credentials in errors. */ }
}
if (!token) throw new Error('Set HEROUI_PERSONAL_TOKEN or configure the private HeroUI credentials file.');
const child = spawn('npx', ['-y', 'hpmcp@0.0.18', channel, token], { stdio: 'inherit', shell: false });
child.on('error', () => { console.error('Unable to start hpmcp.'); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
