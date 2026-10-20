import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import { NodePathInspector } from '../src/index.js';

const inspector = new NodePathInspector({ platform: 'darwin' });
const isRoot = process.getuid?.() === 0;

describe('NodePathInspector', () => {
  let temp: ReturnType<typeof createTempDir>;
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => {
    chmodSync(temp.dir, 0o755);
    temp.cleanup();
  });

  it('reports an available directory with a suggested name', async () => {
    const dir = path.join(temp.dir, 'my-project');
    mkdirSync(dir);
    const result = await inspector.inspect(dir);
    expect(result).toMatchObject({
      resolvedPath: dir,
      availability: { status: 'available' },
      git: { isRepository: false },
      suggestedName: 'my-project',
    });
  });

  it('reports missing directories', async () => {
    const result = await inspector.inspect(path.join(temp.dir, 'nope'));
    expect(result.availability.status).toBe('missing');
    expect(result.resolvedPath).toBeUndefined();
  });

  it('reports files as not a directory', async () => {
    const file = path.join(temp.dir, 'file.txt');
    writeFileSync(file, 'x');
    expect((await inspector.inspect(file)).availability.status).toBe('not-a-directory');
  });

  it('resolves symbolic links to the real directory', async () => {
    const real = path.join(temp.dir, 'real');
    const link = path.join(temp.dir, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    expect((await inspector.inspect(link)).resolvedPath).toBe(real);
  });

  it('reports an unresponsive volume as unreachable instead of hanging', async () => {
    class HangingInspector extends NodePathInspector {
      protected override inspectNow(): never {
        return new Promise(() => undefined) as never;
      }
    }
    const hanging = new HangingInspector({ platform: 'darwin', timeoutMs: 20 });
    const result = await hanging.inspect('/Volumes/disconnected-share/project');
    expect(result.availability.status).toBe('missing');
    expect(result.resolvedPath).toBeUndefined();
  });

  it('reports broken symbolic links as missing', async () => {
    const link = path.join(temp.dir, 'broken');
    symlinkSync(path.join(temp.dir, 'gone'), link);
    expect((await inspector.inspect(link)).availability.status).toBe('missing');
  });

  it.skipIf(isRoot || process.platform === 'win32')(
    'reports directories without read permission',
    async () => {
      const locked = path.join(temp.dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect((await inspector.inspect(locked)).availability.status).toBe('permission-denied');
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});
