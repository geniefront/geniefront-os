import { defineConfig } from 'vitest/config';

// Deliberately no .env, seed/reset hooks or database imports. These suites mock
// persistence, so running the performance regressions cannot reach a real DB.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/public/partyAvailability.unit.test.ts',
      'src/voice/contextCache.unit.test.ts',
      'src/voice/snapshotRefresh.unit.test.ts',
      'src/voice/snapshotWorker.unit.test.ts',
      'src/voice/offers.performance.test.ts',
    ],
    restoreMocks: true,
  },
});
