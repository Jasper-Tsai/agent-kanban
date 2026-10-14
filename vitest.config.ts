import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
  },
});
