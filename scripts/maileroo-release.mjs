#!/usr/bin/env node
// API-only release: preserve the deployed base, remote settings, and all frontend assets.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
const [action, target] = process.argv.slice(2);
if (!['production','staging'].includes(target)) throw new Error('Specify production or staging');
const statePath = `.env.maileroo-release-${target}`;
const files = ['apps/api/src/email/maileroo.ts','apps/api/src/email/mailerooWebhook.ts','apps/api/src/email/provider.ts',
  'apps/api/src/email/send.ts','apps/api/src/email/flush.ts','apps/api/src/email/service.ts','apps/api/src/email/domains.ts',
  'apps/api/src/email/sender.ts','apps/api/src/email/validation.ts','apps/api/src/email/marketingDomain.ts',
  'apps/api/src/platform/emailRoutes.ts','apps/api/src/server.ts','apps/api/src/rawBody.ts'];
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: ['pipe','pipe','pipe'], ...options });
const host = target === 'production' ? 'gf-a' : 'gf-staging';
if (action === 'build') {
  const remote = run('ssh', [host, 'docker inspect --format "{{.Config.Image}}" $(docker ps -q --filter name=api-1)']).toString().trim();
  const base = remote.includes(':maileroo-') ? JSON.parse(readFileSync(statePath,'utf8')).base : remote.split(':')[1].split('-')[0];
  run('git', ['cat-file','-e',`${base}^{commit}`]);
  const context = mkdtempSync(join(tmpdir(), `gf-maileroo-${target}-`));
  const archive = run('git', ['archive', base], { maxBuffer: 100 * 1024 * 1024 });
  run('tar', ['-xf','-','-C',context], { input: archive });
  for (const file of files) { mkdirSync(dirname(join(context,file)), { recursive: true }); cpSync(file, join(context,file)); }
  const tag = `maileroo-${target}-${Date.now()}`;
  writeFileSync(statePath, JSON.stringify({ tag, base, previous: remote, context }), { mode: 0o600 });
  console.log(`Building ${target} from deployed base ${base} with only email changes: ${tag}`);
  const built = spawnSync('docker', ['build','--platform','linux/amd64','--provenance=false','-f',join(context,'deploy/Dockerfile'),'-t',`geniefront/api:${tag}`,context], { stdio: 'inherit' });
  process.exitCode = built.status ?? 1;
} else if (action === 'deploy') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const local = parseEnv(readFileSync(`.env.${target}`, 'utf8'));
  const names = ['MAILEROO_API_KEY','MAILEROO_ACCOUNT_API_KEY','MAILEROO_APPLICATION_ID','MAILEROO_WEBHOOK_SECRET'];
  if (names.some(k => !local[k])) throw new Error('Maileroo credentials incomplete');
  const directory = target === 'production' ? '/opt/geniefront' : '/opt/geniefront-staging';
  for (const name of target === 'production' ? ['gf-a','gf-b'] : ['gf-staging']) {
    const remoteImage = run('ssh', [name, 'docker inspect --format "{{.Config.Image}}" $(docker ps -q --filter name=api-1)']).toString().trim();
    if (remoteImage !== state.previous && remoteImage !== `geniefront/api:${state.tag}`) throw new Error(`Deployment changed on ${name}; refusing overwrite`);
    // Both image names and SSH aliases above are controlled values, never credentials.
    run('bash', ['-c', `set -o pipefail; docker save geniefront/api:${state.tag} | gzip -1 | ssh ${name} 'gunzip | docker load'`], { maxBuffer: 1024 * 1024 });
    const prior = run('ssh', [name, `cat ${directory}/.env`]).toString();
    let next = prior;
    for (const key of [...names,'EMAIL_PROVIDER']) {
      const value = key === 'EMAIL_PROVIDER' ? 'maileroo' : local[key];
      const re = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${JSON.stringify(value)}`;
      next = re.test(next) ? next.replace(re, () => line) : `${next}\n${line}\n`;
    }
    next = next.replace(/^MAILSLURP_API_KEY=.*\n?/gm, '');
    run('ssh', [name, `cp -p ${directory}/.env ${directory}/.env.before-${state.tag} && umask 077 && cat > ${directory}/.env`], { input: next });
    run('ssh', [name, `cd ${directory} && TAG=${state.tag} RUNTIME_ENV_FILE=.env docker compose --env-file .env up -d --no-deps api`]);
    const check = run('ssh', [name, 'for n in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/health && exit 0; sleep 2; done; exit 1']).toString();
    console.log(`${name}: ${check.trim()}`);
  }
  let content = readFileSync(`.env.${target}`, 'utf8').replace(/^EMAIL_PROVIDER=.*$/m, 'EMAIL_PROVIDER=maileroo');
  content = content.replace(/^MAILSLURP_API_KEY=.*\n?/gm, '');
  writeFileSync(`.env.${target}`, content, { mode: 0o600 });
  console.log(`API-only ${target} release complete; previous image: ${state.previous}`);
} else throw new Error('Use build|deploy');
