import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';

/** Aggregate only; never logs request/customer data. */
export function startEventLoopMonitoring(app: FastifyInstance, role: 'api' | 'voice-snapshot') {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previous = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const current = performance.eventLoopUtilization();
    const utilization = performance.eventLoopUtilization(current, previous).utilization;
    previous = current;
    const maxMs = delay.max / 1e6;
    const values = { role, p99Ms: delay.percentile(99) / 1e6, maxMs, utilization };
    if (maxMs > 250) app.log.warn(values, 'Event loop delay');
    else app.log.info(values, 'Event loop health');
    delay.reset();
  }, 30_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); delay.disable(); });
}
