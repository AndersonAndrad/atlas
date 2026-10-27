import { rmSync } from 'node:fs';

const projects = [
  'packages/shared',
  'packages/contracts',
  'packages/projects',
  'packages/terminal',
  'packages/persistence',
  'packages/skills',
  'packages/usage',
  'packages/preflight',
  'packages/notifications',
  'packages/notes',
  'packages/jobs',
  'packages/docker',
  'packages/api-workbench',
  'packages/extensions',
  'packages/editor',
  'apps/engine',
  'apps/cli',
];

const targets = [
  // tsc -b skips projects whose build info is current, so it must go with dist.
  ...projects.flatMap((project) => [`${project}/dist`, `${project}/tsconfig.tsbuildinfo`]),
  'apps/desktop/out',
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}
