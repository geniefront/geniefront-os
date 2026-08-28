import { defineConfig } from 'vitest/config';
import { createSharedTestConfig } from '../../vitest.shared';

export default defineConfig({ test: createSharedTestConfig({ database: true }) });
