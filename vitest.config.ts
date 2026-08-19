import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // No live network in tests: every upstream response is a committed fixture.
    environment: 'node',
    coverage: { include: ['src/domain/**', 'src/x/decode.ts', 'src/infra/retry.ts'] },
  },
});
