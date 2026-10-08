import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['src/stripe/*.unit.test.ts'] } });
