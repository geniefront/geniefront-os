import { defineConfig } from 'vitest/config';
// Mocked query/route tests only. No database connection or seed/reset hooks.
export default defineConfig({ test: { environment: 'node', include: ['src/queries/receipt.unit.test.ts'], restoreMocks: true } });
