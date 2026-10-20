import { resolve } from 'node:path';
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
  '@atlas/projects': 'packages/projects/src/index.ts',
  '@atlas/persistence': 'packages/persistence/src/index.ts',
  '@atlas/engine': 'apps/engine/src/index.ts',
};
const workspaceAliases = Object.entries(workspaceSources).map(([name, source]) => ({
  find: new RegExp(`^${name.replace(/[/]/g, '\\/')}$`),
  replacement: resolve(root, source),
}));
const workspacePackages = Object.keys(workspaceSources);

/**
 * Injects the Content-Security-Policy. The dev server needs inline scripts for
 * React Fast Refresh and a websocket for HMR; production builds do not.
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
        : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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
    build: {
      externalizeDeps: { exclude: [...workspacePackages, 'zod'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
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
    resolve: { alias: workspaceAliases },
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
