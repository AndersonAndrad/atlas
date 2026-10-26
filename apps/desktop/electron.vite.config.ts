import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const root = resolve(__dirname, '../..');

// Workspace packages are compiled from source and bundled into the main process.
const workspaceSources: Record<string, string> = {
  '@atlas/shared': 'packages/shared/src/index.ts',
  '@atlas/contracts': 'packages/contracts/src/index.ts',
  // Dependency-free subpath so the preload bundle does not include Zod.
  '@atlas/contracts/ipc': 'packages/contracts/src/ipc.ts',
  '@atlas/conventional-commits': 'packages/conventional-commits/src/index.ts',
  '@atlas/git': 'packages/git/src/index.ts',
  '@atlas/projects': 'packages/projects/src/index.ts',
  '@atlas/terminal': 'packages/terminal/src/index.ts',
  '@atlas/sessions': 'packages/sessions/src/index.ts',
  '@atlas/context': 'packages/context/src/index.ts',
  '@atlas/skills': 'packages/skills/src/index.ts',
  '@atlas/usage': 'packages/usage/src/index.ts',
  '@atlas/preflight': 'packages/preflight/src/index.ts',
  '@atlas/notifications': 'packages/notifications/src/index.ts',
  '@atlas/notes': 'packages/notes/src/index.ts',
  '@atlas/editor': 'packages/editor/src/index.ts',
  '@atlas/persistence': 'packages/persistence/src/index.ts',
  '@atlas/engine': 'apps/engine/src/index.ts',
};
const workspaceAliases = Object.entries(workspaceSources).map(([name, source]) => ({
  find: new RegExp(`^${name.replace(/[/]/g, '\\/')}$`),
  replacement: resolve(root, source),
}));
const workspacePackages = Object.keys(workspaceSources);

/** The Engine's own version, so About can tell it apart from the desktop version. */
const engineVersion = (
  JSON.parse(readFileSync(resolve(root, 'apps/engine/package.json'), 'utf8')) as { version: string }
).version;

/** Source revision of the build ("<short hash>[-dirty]"), or empty when unknown. */
function buildId(): string {
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const hash = git(['rev-parse', '--short', 'HEAD']);
    return git(['status', '--porcelain']) === '' ? hash : `${hash}-dirty`;
  } catch {
    return '';
  }
}

/**
 * Injects the Content-Security-Policy. The dev server needs inline scripts for
 * React Fast Refresh and a websocket for HMR; production builds do not.
 * `style-src 'unsafe-inline'` is required in production because xterm.js and
 * Radix UI inject <style> elements at runtime; scripts stay strictly 'self'.
 */
function contentSecurityPolicy(): Plugin {
  let isDev = false;
  return {
    name: 'atlas-csp',
    configResolved(config) {
      isDev = config.command === 'serve';
    },
    transformIndexHtml() {
      const policy = isDev
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:"
        : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: workspaceAliases },
    define: {
      __ATLAS_ENGINE_VERSION__: JSON.stringify(engineVersion),
      __ATLAS_BUILD_ID__: JSON.stringify(buildId()),
    },
    build: {
      externalizeDeps: { exclude: [...workspacePackages, 'zod'] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Utility process that hosts the Engine and owns terminal processes.
          'engine-host': resolve(__dirname, 'src/engine-host/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: workspaceAliases },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: [
        ...workspaceAliases,
        { find: /^@\//, replacement: `${resolve(__dirname, 'src/renderer/src')}/` },
      ],
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    build: {
      // electron-vite does not minify by default; the renderer is the largest bundle.
      minify: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
