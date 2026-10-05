import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const postgres = require('postgres');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Called only with the disposable database created by test-booking-performance. */
export async function verifyBookingWorkerIsolation(env, root) {
  const url = new URL(env.MIGRATION_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(['/gf_booking_performance_test', '/gf_commerce_stage_ci'].includes(url.pathname));
  assert.equal(env.NODE_ENV, 'test');
  const directory = await mkdtemp(join(tmpdir(), 'gf-booking-isolation-'));
  const db = postgres(url.href, { max: 1, onnotice: () => {} });
  const children = [];
  try {
    for (const [name, entry] of [['api', 'apps/api/src/main.ts'], ['worker', 'apps/api/src/voice/snapshotMain.ts']]) {
      const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true,
        platform: 'node', target: 'node22', format: 'esm', outfile: join(directory, `${name}.mjs`), metafile: true,
        banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" } });
      const inputs = Object.keys(result.metafile.inputs);
      assert.equal(inputs.some(path => path.endsWith('/voice/snapshotWorker.ts')), name === 'worker');
      assert.equal(inputs.some(path => path.endsWith('/voice/snapshotRefresh.ts')), name === 'worker');
    }
    // Test-only preload. No stall/IPC control is shipped in either application.
    const preload = join(directory, 'cpu-fixture.mjs');
    await writeFile(preload, `process.on('message', message => {
      if (message !== 'cpu-stall') return;
      process.send({state:'busy'}, () => {
        const end = performance.now() + 6000;
        while (performance.now() < end) {}
        process.send({state:'idle'});
      });
    });`);
    const launch = async (name, extra = {}) => {
      const child = spawn(process.execPath, ['--import', preload, join(directory, `${name}.mjs`)], {
        cwd: root, env: { ...env, ...extra, PORT: '0', LOG_LEVEL: 'info' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let address;
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
      let pending = '';
      child.stdout.on('data', chunk => {
        pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const message = JSON.parse(line).msg ?? '';
            const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(message);
            if (match) address = match[1];
          } catch { /* only structured readiness is used */ }
        }
      });
      for (let i = 0; i < 100 && !address; i++) {
        if (child.exitCode !== null) throw new Error(`${name} exited during startup: ${stderr}`);
        await delay(100);
      }
      assert.ok(address, `${name} did not become ready`);
      return { child, address };
    };

    const [shop] = await db`select l.id,l.public_key,l.slug from locations l join phone_lines p on p.location_id=l.id
      where p.active and p.ai_answer and p.assistant_id like 'agent_%' limit 1`;
    assert.ok(shop, 'Voice test fixture must supply an active AI shop');
    const [before] = await db`select generated_at::text from voice_availability_snapshots where location_id=${shop.id}`;
    await db`update voice_availability_snapshots set refresh_after=now(),retry_after=now() where location_id=${shop.id}`;
    const api = await launch('api');
    const worker = await launch('worker', { DB_POOL_MAX: '2' });
    let refreshed = false;
    for (let i = 0; i < 100 && !refreshed; i++) {
      const [row] = await db`select generated_at::text,payload is not null as has_payload from voice_availability_snapshots where location_id=${shop.id}`;
      refreshed = !!row?.has_payload && row.generated_at !== before?.generated_at;
      if (!refreshed) await delay(100);
    }
    assert.ok(refreshed, 'Standalone worker must publish a real database-backed snapshot');
    assert.equal((await fetch(`${worker.address}/health`)).status, 200);

    const busy = new Promise(resolve => worker.child.on('message', message => { if (message.state === 'busy') resolve(); }));
    const idle = new Promise(resolve => worker.child.on('message', message => { if (message.state === 'idle') resolve(); }));
    worker.child.send('cpu-stall');
    await bounded(busy, 'Worker stall acknowledgement');
    const elapsed = [];
    // Real HTTP reads while worker's main thread is deliberately blocked >5s.
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const path = i % 3 === 0 ? '/health' : i % 3 === 1
        ? `/public/v1/hosted/shops/${encodeURIComponent(shop.slug)}` : '/public/v1/services';
      const response = await fetch(`${api.address}${path}`, {
        headers: { 'X-GF-Public-Key': shop.public_key }, signal: AbortSignal.timeout(1000),
      });
      assert.equal(response.status, 200, path);
      await response.json();
      elapsed.push(performance.now() - start);
      await delay(100);
    }
    await bounded(idle, 'Worker stall completion');
    elapsed.sort((a, b) => a - b);
    console.log(`Worker isolation: 6s CPU stall; ${elapsed.length} API reads all 200; P95 ${Math.round(elapsed[Math.floor(elapsed.length * .95)])}ms, max ${Math.round(elapsed.at(-1))}ms`);
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { await exited; } finally { clearTimeout(timeout); }
    }));
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
}
