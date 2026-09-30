import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', include: ['src/voice/requestedTime.unit.test.ts', 'src/voice/reconciliation.unit.test.ts'],
  fileParallelism: false,
} });
