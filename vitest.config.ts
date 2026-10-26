import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  // Renderer components (.tsx) use the automatic JSX runtime, as in the desktop build.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: /^@atlas\/shared$/, replacement: src('./packages/shared/src/index.ts') },
      { find: /^@atlas\/contracts$/, replacement: src('./packages/contracts/src/index.ts') },
      { find: /^@atlas\/contracts\/ipc$/, replacement: src('./packages/contracts/src/ipc.ts') },
      {
        find: /^@atlas\/conventional-commits$/,
        replacement: src('./packages/conventional-commits/src/index.ts'),
      },
      { find: /^@atlas\/git$/, replacement: src('./packages/git/src/index.ts') },
      { find: /^@atlas\/projects$/, replacement: src('./packages/projects/src/index.ts') },
      { find: /^@atlas\/terminal$/, replacement: src('./packages/terminal/src/index.ts') },
      { find: /^@atlas\/sessions$/, replacement: src('./packages/sessions/src/index.ts') },
      { find: /^@atlas\/context$/, replacement: src('./packages/context/src/index.ts') },
      { find: /^@atlas\/skills$/, replacement: src('./packages/skills/src/index.ts') },
      { find: /^@atlas\/usage$/, replacement: src('./packages/usage/src/index.ts') },
      { find: /^@atlas\/preflight$/, replacement: src('./packages/preflight/src/index.ts') },
      {
        find: /^@atlas\/notifications$/,
        replacement: src('./packages/notifications/src/index.ts'),
      },
      { find: /^@atlas\/notes$/, replacement: src('./packages/notes/src/index.ts') },
      { find: /^@atlas\/editor$/, replacement: src('./packages/editor/src/index.ts') },
      { find: /^@atlas\/persistence$/, replacement: src('./packages/persistence/src/index.ts') },
      { find: /^@atlas\/engine$/, replacement: src('./apps/engine/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Many tests start real processes (git, shells, wrappers); 5 s is too short on a busy
    // machine or CI runner (PLAN-038).
    testTimeout: 15_000,
  },
});
