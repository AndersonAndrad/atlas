import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@atlas\/shared$/, replacement: src('./packages/shared/src/index.ts') },
      { find: /^@atlas\/contracts$/, replacement: src('./packages/contracts/src/index.ts') },
      { find: /^@atlas\/contracts\/ipc$/, replacement: src('./packages/contracts/src/ipc.ts') },
      { find: /^@atlas\/projects$/, replacement: src('./packages/projects/src/index.ts') },
      { find: /^@atlas\/terminal$/, replacement: src('./packages/terminal/src/index.ts') },
      { find: /^@atlas\/persistence$/, replacement: src('./packages/persistence/src/index.ts') },
      { find: /^@atlas\/engine$/, replacement: src('./apps/engine/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
