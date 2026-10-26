import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  chmod,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRelativeFilePath, type FileEncoding } from '@atlas/contracts';
import {
  EditorSettings,
  FileWatchHub,
  ProjectFiles,
  bestMatches,
  contentVersion,
  decodeText,
  encodeText,
  fuzzyScore,
  lineEndings,
  type ProjectIgnoreRules,
} from '@atlas/editor';
import { AtlasError, noopLogger } from '@atlas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const UNKNOWN = '00000000-0000-4000-8000-000000000002';

let base: string;
let root: string;
let outside: string;
let changed: string[];
let ignoreRules: ProjectIgnoreRules;
let hub: FileWatchHub;

function service(overrides: Partial<ProjectIgnoreRules> = {}) {
  ignoreRules = {
    ignored: async () => null,
    files: async () => null,
    ...overrides,
  };
  return new ProjectFiles({
    workspaces: {
      projectRoot: async (projectId) => {
        if (projectId !== PROJECT) throw new AtlasError('PROJECT_NOT_FOUND');
        return root;
      },
    },
    ignore: ignoreRules,
    watcher: hub,
    logger: noopLogger,
    onChanged: (projectRoot) => changed.push(projectRoot),
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AtlasError) return error.code;
    throw error;
  }
  return 'resolved';
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'atlas-editor-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  changed = [];
  hub = new FileWatchHub({ onChange: () => undefined, logger: noopLogger });
});

afterEach(async () => {
  hub.close();
  await rm(base, { recursive: true, force: true });
});

describe('relative paths (FR-1101, §10)', () => {
  it('accepts project paths and rejects traversal, absolute and empty segments', () => {
    expect(isRelativeFilePath('')).toBe(true);
    expect(isRelativeFilePath('src/index.ts')).toBe(true);
    expect(isRelativeFilePath('.github/workflows/ci.yml')).toBe(true);
    for (const bad of ['../x', 'src/../../x', '/etc/passwd', 'src//a', 'src/', './a', 'a\0b']) {
      expect(isRelativeFilePath(bad), bad).toBe(false);
    }
  });

  it('rejects traversal before touching the filesystem', async () => {
    const files = service();
    expect(await code(files.read({ projectId: PROJECT, path: '../outside/secret.txt' }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects unknown projects', async () => {
    expect(await code(service().read({ projectId: UNKNOWN, path: 'src/index.ts' }))).toBe(
      'PROJECT_NOT_FOUND',
    );
  });

  it('never reads, writes or lists through a symbolic link that leaves the project', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await symlink(outside, path.join(root, 'linked-dir'));
    const files = service();
    expect(await code(files.read({ projectId: PROJECT, path: 'link.txt' }))).toBe(
      'FILE_OUTSIDE_WORKSPACE',
    );
    expect(
      await code(
        files.write({
          projectId: PROJECT,
          path: 'linked-dir/new.txt',
          content: 'x',
          encoding: 'utf8',
          expectedVersion: null,
        }),
      ),
    ).toBe('FILE_OUTSIDE_WORKSPACE');
    expect(await code(files.list({ projectId: PROJECT, path: 'linked-dir' }))).toBe(
      'FILE_OUTSIDE_WORKSPACE',
    );
    expect(await readdir(outside)).toEqual(['secret.txt']);
    const listing = await files.list({ projectId: PROJECT, path: '' });
    expect(listing.entries.find((entry) => entry.name === 'link.txt')).toMatchObject({
      symlink: true,
      outside: true,
      kind: 'file',
    });
  });

  it('follows symbolic links that stay inside the project', async () => {
    await symlink(path.join(root, 'src', 'index.ts'), path.join(root, 'alias.ts'));
    const files = service();
    const opened = await files.read({ projectId: PROJECT, path: 'alias.ts' });
    await files.write({
      projectId: PROJECT,
      path: 'alias.ts',
      content: 'export const a = 2;\n',
      encoding: 'utf8',
      expectedVersion: opened.version,
    });
    // The link is kept and its target changed.
    expect((await readFile(path.join(root, 'src', 'index.ts'), 'utf8')).trim()).toBe(
      'export const a = 2;',
    );
  });
});

describe('reading', () => {
  it('returns the content, its version and line endings', async () => {
    await writeFile(path.join(root, 'crlf.txt'), 'a\r\nb\r\n');
    const file = await service().read({ projectId: PROJECT, path: 'crlf.txt' });
    expect(file).toMatchObject({
      content: 'a\r\nb\r\n',
      encoding: 'utf8',
      eol: 'CRLF',
      mixedEol: false,
      readOnly: false,
      size: 6,
      version: contentVersion(Buffer.from('a\r\nb\r\n')),
    });
  });

  it('refuses binary, unsupported and too large files', async () => {
    await writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0xe7, 0x61]));
    await writeFile(path.join(root, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const files = service();
    expect(await code(files.read({ projectId: PROJECT, path: 'image.png' }))).toBe(
      'FILE_UNSUPPORTED',
    );
    expect(await code(files.read({ projectId: PROJECT, path: 'latin1.txt' }))).toBe(
      'FILE_UNSUPPORTED',
    );
    expect(await code(files.read({ projectId: PROJECT, path: 'big.log' }))).toBe('FILE_TOO_LARGE');
    expect(await code(files.read({ projectId: PROJECT, path: 'src' }))).toBe('FILE_UNSUPPORTED');
    expect(await code(files.read({ projectId: PROJECT, path: 'missing.ts' }))).toBe(
      'FILE_NOT_FOUND',
    );
  });

  it('reports files ATLAS cannot write as read-only', async () => {
    if (process.getuid?.() === 0) return;
    await writeFile(path.join(root, 'locked.txt'), 'x');
    await chmod(path.join(root, 'locked.txt'), 0o444);
    expect((await service().read({ projectId: PROJECT, path: 'locked.txt' })).readOnly).toBe(true);
  });
});

describe('saving (FR-1106, FR-1107)', () => {
  it('saves over the version the user edited and keeps the permissions', async () => {
    const target = path.join(root, 'run.sh');
    await writeFile(target, 'echo 1\n');
    await chmod(target, 0o751);
    const files = service();
    const opened = await files.read({ projectId: PROJECT, path: 'run.sh' });
    const written = await files.write({
      projectId: PROJECT,
      path: 'run.sh',
      content: 'echo 2\n',
      encoding: 'utf8',
      expectedVersion: opened.version,
    });
    expect(await readFile(target, 'utf8')).toBe('echo 2\n');
    expect((await stat(target)).mode & 0o777).toBe(0o751);
    expect(written.version).toBe(contentVersion(Buffer.from('echo 2\n')));
    expect(changed).toEqual([root]);
    // No temporary file is left behind.
    expect((await readdir(root)).filter((name) => name.includes('.atlas-'))).toEqual([]);
  });

  it('never overwrites a file changed on disk since it was opened', async () => {
    const files = service();
    const opened = await files.read({ projectId: PROJECT, path: 'src/index.ts' });
    await writeFile(path.join(root, 'src', 'index.ts'), 'changed by Claude\n');
    const save = (overwrite?: boolean) =>
      files.write({
        projectId: PROJECT,
        path: 'src/index.ts',
        content: 'mine\n',
        encoding: 'utf8',
        expectedVersion: opened.version,
        ...(overwrite ? { overwrite } : {}),
      });
    expect(await code(save())).toBe('FILE_CONFLICT');
    expect(await readFile(path.join(root, 'src', 'index.ts'), 'utf8')).toBe('changed by Claude\n');
    // Only after the user chose to keep their version.
    await save(true);
    expect(await readFile(path.join(root, 'src', 'index.ts'), 'utf8')).toBe('mine\n');
  });

  it('reports a file deleted on disk as a conflict, and recreates it when asked', async () => {
    const files = service();
    const opened = await files.read({ projectId: PROJECT, path: 'src/index.ts' });
    await rm(path.join(root, 'src', 'index.ts'));
    const input = {
      projectId: PROJECT,
      path: 'src/index.ts',
      content: 'back\n',
      encoding: 'utf8' as const,
      expectedVersion: opened.version,
    };
    expect(await code(files.write(input))).toBe('FILE_CONFLICT');
    await files.write({ ...input, overwrite: true });
    expect(await readFile(path.join(root, 'src', 'index.ts'), 'utf8')).toBe('back\n');
  });

  it('Save As creates a new file and never replaces an existing one silently', async () => {
    const files = service();
    const input = {
      projectId: PROJECT,
      path: 'src/copy.ts',
      content: 'copy\n',
      encoding: 'utf8' as const,
      expectedVersion: null,
    };
    await files.write(input);
    expect(await readFile(path.join(root, 'src', 'copy.ts'), 'utf8')).toBe('copy\n');
    expect(await code(files.write({ ...input, content: 'other\n' }))).toBe('FILE_ALREADY_EXISTS');
    expect(await readFile(path.join(root, 'src', 'copy.ts'), 'utf8')).toBe('copy\n');
    await files.write({ ...input, content: 'confirmed\n', overwrite: true });
    expect(await readFile(path.join(root, 'src', 'copy.ts'), 'utf8')).toBe('confirmed\n');
    expect(await code(files.write({ ...input, path: 'missing/dir/a.ts' }))).toBe('FILE_NOT_FOUND');
  });

  it.each<FileEncoding>(['utf8', 'utf8bom', 'utf16le', 'utf16be'])(
    'keeps the %s encoding',
    async (encoding) => {
      const bytes = encodeText('olá\r\nmundo', encoding);
      await writeFile(path.join(root, 'enc.txt'), bytes);
      const files = service();
      const opened = await files.read({ projectId: PROJECT, path: 'enc.txt' });
      expect(opened).toMatchObject({ content: 'olá\r\nmundo', encoding, eol: 'CRLF' });
      await files.write({
        projectId: PROJECT,
        path: 'enc.txt',
        content: `${opened.content}!`,
        encoding: opened.encoding,
        expectedVersion: opened.version,
      });
      expect(Buffer.from(await readFile(path.join(root, 'enc.txt')))).toEqual(
        Buffer.from(encodeText('olá\r\nmundo!', encoding)),
      );
    },
  );
});

describe('file operations (FR-1102)', () => {
  it('creates files and folders without replacing existing ones', async () => {
    const files = service();
    await files.create({ projectId: PROJECT, path: 'docs', kind: 'directory' });
    await files.create({ projectId: PROJECT, path: 'docs/a.md', kind: 'file' });
    expect(await readFile(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('');
    await writeFile(path.join(root, 'docs', 'a.md'), 'keep');
    expect(await code(files.create({ projectId: PROJECT, path: 'docs/a.md', kind: 'file' }))).toBe(
      'FILE_ALREADY_EXISTS',
    );
    expect(await code(files.create({ projectId: PROJECT, path: 'docs', kind: 'directory' }))).toBe(
      'FILE_ALREADY_EXISTS',
    );
    expect(await readFile(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('keep');
  });

  it('renames and moves without replacing the destination', async () => {
    const files = service();
    await writeFile(path.join(root, 'b.ts'), 'b');
    await files.move({ projectId: PROJECT, from: 'b.ts', to: 'src/b.ts' });
    expect(await readFile(path.join(root, 'src', 'b.ts'), 'utf8')).toBe('b');
    expect(
      await code(files.move({ projectId: PROJECT, from: 'src/b.ts', to: 'src/index.ts' })),
    ).toBe('FILE_ALREADY_EXISTS');
    expect(await readFile(path.join(root, 'src', 'index.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
    expect(await code(files.move({ projectId: PROJECT, from: 'src', to: 'src/inner' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await code(files.move({ projectId: PROJECT, from: 'nope.ts', to: 'x.ts' }))).toBe(
      'FILE_NOT_FOUND',
    );
    await files.move({ projectId: PROJECT, from: 'src', to: 'lib' });
    expect(await readdir(path.join(root, 'lib'))).toEqual(['b.ts', 'index.ts']);
  });

  it('allows a case-only rename', async () => {
    const files = service();
    await files.move({ projectId: PROJECT, from: 'src/index.ts', to: 'src/Index.ts' });
    expect(await readdir(path.join(root, 'src'))).toEqual(['Index.ts']);
  });

  it('gives the main process the absolute path of an existing entry only', async () => {
    await symlink(outside, path.join(root, 'linked-dir'));
    const files = service();
    expect(await files.absolutePath({ projectId: PROJECT, path: 'src/index.ts' })).toBe(
      path.join(root, 'src', 'index.ts'),
    );
    // The link itself (inside the project) would go to the Trash, not its target.
    expect(await files.absolutePath({ projectId: PROJECT, path: 'linked-dir' })).toBe(
      path.join(root, 'linked-dir'),
    );
    expect(
      await code(files.absolutePath({ projectId: PROJECT, path: 'linked-dir/secret.txt' })),
    ).toBe('FILE_OUTSIDE_WORKSPACE');
    expect(await code(files.absolutePath({ projectId: PROJECT, path: 'gone.txt' }))).toBe(
      'FILE_NOT_FOUND',
    );
  });
});

describe('listing and ignore rules (FR-1101, FR-1103)', () => {
  beforeEach(async () => {
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.env'), 'X=1');
    await writeFile(path.join(root, 'README.md'), '# hi');
    await writeFile(path.join(root, '.README.md.atlas-0123456789ab.tmp'), 'temp');
  });

  it('lists folders first and hides the default ignored names outside repositories', async () => {
    const listing = await service().list({ projectId: PROJECT, path: '' });
    expect(listing.entries.map((entry) => entry.name)).toEqual(['src', '.env', 'README.md']);
    expect(listing.hiddenIgnored).toBe(2);
    const all = await service().list({ projectId: PROJECT, path: '', showIgnored: true });
    expect(all.entries.filter((entry) => entry.ignored).map((entry) => entry.name)).toEqual([
      '.git',
      'node_modules',
    ]);
    const visible = await service().list({ projectId: PROJECT, path: '', showHidden: false });
    expect(visible.entries.map((entry) => entry.name)).toEqual(['src', 'README.md']);
  });

  it("uses the repository's own rules when there are any", async () => {
    const files = service({ ignored: async () => new Set(['README.md']) });
    const listing = await files.list({ projectId: PROJECT, path: '' });
    // node_modules is not ignored by these rules, so it is listed; .git always is.
    expect(listing.entries.map((entry) => entry.name)).toEqual(['node_modules', 'src', '.env']);
  });

  it('falls back to the default list when the rules fail', async () => {
    const files = service({
      ignored: async () => {
        throw new Error('git missing');
      },
    });
    expect((await files.list({ projectId: PROJECT, path: '' })).entries.map((e) => e.name)).toEqual(
      ['src', '.env', 'README.md'],
    );
  });
});

describe('quick open (FR-1101)', () => {
  it('searches the repository file list when there is one', async () => {
    const files = service({
      files: async () => ({
        paths: ['src/app.tsx', 'src/components/AppShell.tsx', 'README.md'],
        truncated: false,
      }),
    });
    expect((await files.find({ projectId: PROJECT, query: 'appsh' })).paths).toEqual([
      'src/components/AppShell.tsx',
    ]);
  });

  it('walks the folder without the ignored folders otherwise', async () => {
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.ts'), '');
    const result = await service().find({ projectId: PROJECT, query: 'index' });
    expect(result).toEqual({ paths: ['src/index.ts'], truncated: false });
  });

  it('ranks file-name matches first', () => {
    expect(bestMatches('index', ['lib/index-helpers/a.ts', 'src/index.ts'], 5)).toEqual([
      'src/index.ts',
      'lib/index-helpers/a.ts',
    ]);
    expect(fuzzyScore('zz', 'src/index.ts')).toBeNull();
  });
});

describe('versions and watching (FR-1107)', () => {
  it('reports current versions and missing files', async () => {
    const files = service();
    const [present, missing] = await files.versions({
      projectId: PROJECT,
      paths: ['src/index.ts', 'gone.ts'],
    });
    expect(present).toEqual({
      path: 'src/index.ts',
      exists: true,
      version: contentVersion(Buffer.from('export const a = 1;\n')),
    });
    expect(missing).toEqual({ path: 'gone.ts', exists: false, version: null });
  });

  it('reports changes in watched folders, debounced and without temporary files', async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, (file: string | null) => void>();
      const closed: string[] = [];
      const events: [string, string[]][] = [];
      const watchHub = new FileWatchHub({
        onChange: (projectId, paths) => events.push([projectId, paths]),
        debounceMs: 50,
        watch: (directory, listener) => {
          listeners.set(directory, listener);
          return { on: () => undefined, close: () => closed.push(directory) } as never;
        },
      });
      watchHub.set('window-1', {
        projectId: PROJECT,
        directories: [
          { relative: '', absolute: '/p' },
          { relative: 'src', absolute: '/p/src' },
        ],
      });
      listeners.get('/p/src')!('index.ts');
      listeners.get('/p/src')!('.index.ts.atlas-0123456789ab.tmp');
      listeners.get('/p')!('README.md');
      listeners.get('/p/src')!('index.ts');
      expect(events).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(events).toEqual([[PROJECT, ['src/index.ts', 'README.md']]]);
      // A shared folder stays watched until its last client stops.
      watchHub.set('window-2', {
        projectId: PROJECT,
        directories: [{ relative: 'src', absolute: '/p/src' }],
      });
      watchHub.set('window-1', null);
      expect(closed).toEqual(['/p']);
      expect(watchHub.watchedCount).toBe(1);
      watchHub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips folders that are no longer available', async () => {
    const files = service();
    await files.watch('w', { projectId: PROJECT, directories: ['src', 'gone'] });
    expect(hub.watchedCount).toBe(1);
    await files.watch('w', { projectId: null, directories: [] });
    expect(hub.watchedCount).toBe(0);
  });
});

describe('text helpers', () => {
  it('detects line endings', () => {
    expect(lineEndings('a\nb')).toEqual({ eol: 'LF', mixedEol: false });
    expect(lineEndings('a\r\nb\r\nc\n')).toEqual({ eol: 'CRLF', mixedEol: true });
    expect(lineEndings('')).toEqual({ eol: 'LF', mixedEol: false });
  });

  it('treats NUL bytes as binary', () => {
    expect(decodeText(Buffer.from('a\0b'))).toBeNull();
    expect(decodeText(Buffer.from('plain'))?.content).toBe('plain');
  });
});

describe('editor settings (FR-1108, FR-1110)', () => {
  const store = () => {
    const values = new Map<string, string>();
    return {
      values,
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => void values.set(key, value),
      delete: async (key: string) => void values.delete(key),
    };
  };

  it('merges preference changes over defaults', async () => {
    const settings = new EditorSettings(store());
    expect((await settings.getPreferences()).fontSize).toBe(13);
    const next = await settings.updatePreferences({ fontSize: 15, minimap: false });
    expect(next).toMatchObject({ fontSize: 15, minimap: false, tabSize: 2, autoReload: true });
    expect(await settings.getPreferences()).toEqual(next);
    await expect(settings.updatePreferences({ fontSize: 99 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('stores file references only and drops invalid stored layouts', async () => {
    const backing = store();
    const settings = new EditorSettings(backing);
    const layout = {
      tabs: [{ path: 'src/index.ts', line: 3, column: 1, scrollTop: 40 }],
      activePath: 'src/index.ts',
      explorerVisible: true,
      explorerSize: 20,
      terminalVisible: false,
      terminalSize: 30,
      expanded: ['src'],
    };
    await settings.setLayout(PROJECT, layout);
    expect(await settings.getLayout(PROJECT)).toEqual(layout);
    await expect(
      settings.setLayout(PROJECT, { ...layout, tabs: [{ path: '../x' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(settings.setLayout(PROJECT, { ...layout, content: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    backing.values.set(`editor.layout.${PROJECT}`, '{"tabs": 1}');
    expect(await settings.getLayout(PROJECT)).toBeNull();
    await settings.setLastProject(PROJECT);
    expect(await settings.getLastProject()).toBe(PROJECT);
    await settings.setLastProject(null);
    expect(await settings.getLastProject()).toBeNull();
  });
});
