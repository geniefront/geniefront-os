/** Separate OS process: no API routes, booking handlers or outbound jobs. */
import Fastify from 'fastify';
import { closeDb } from '@gf/db';
import { startVoiceSnapshots } from './snapshotWorker';
import { startEventLoopMonitoring } from '../ops/eventLoop';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true });
startEventLoopMonitoring(app, 'voice-snapshot');
const status = startVoiceSnapshots(app);
app.get('/health', async (_req, reply) => {
  const health = status();
  return reply.code(health.ok ? 200 : 503).send(health);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // Finish the active lease before closing its database connections.
    void app.close().then(async () => { await closeDb(); process.exit(0); })
      .catch(() => process.exit(1));
  });
}
app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })
  .catch(async error => { app.log.error(error); await closeDb(); process.exit(1); });
