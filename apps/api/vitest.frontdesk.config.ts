import { defineConfig } from 'vitest/config';
// Unit tests with mocked tenant storage; never load developer DB credentials.
export default defineConfig({ test: { environment: 'node', include: ['src/forms/summary.unit.test.ts'], restoreMocks: true } });
