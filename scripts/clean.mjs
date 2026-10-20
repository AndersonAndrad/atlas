import { rmSync } from 'node:fs';

const targets = [
  'packages/shared/dist',
  'packages/contracts/dist',
  'packages/projects/dist',
  'packages/persistence/dist',
  'apps/engine/dist',
  'apps/cli/dist',
  'apps/desktop/out',
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}
