// node-pty 1.1.0 ships its macOS `spawn-helper` prebuild without the executable
// bit, which makes every spawn fail with "posix_spawnp failed". Restore it.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(
    require.resolve('node-pty/package.json', { paths: [process.cwd()] }),
  );
  for (const arch of ['arm64', 'x64']) {
    const helper = path.join(packageRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
    }
  }
}
