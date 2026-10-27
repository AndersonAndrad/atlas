import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionsService, type TestedExtension } from '@atlas/extensions';
import { SqliteExtensionRepository, openDatabase, type Database } from '@atlas/persistence';
import { noopLogger } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  fixtureManifest,
  startFakeRegistry,
  vsixOf,
  zip,
  type FakeRegistry,
  type FixtureExtension,
} from '../../../tests/support/vsix.js';
import { FileExtensionPackages } from '../src/adapters/extension-packages.js';
import { OpenVsxRegistry } from '../src/adapters/open-vsx-registry.js';
import { openVsxPlatform } from '../src/engine.js';

// SDD-015 Milestone A against a local stand-in for Open VSX and VSIX packages built by the
// test, including hostile ones. No extension code is ever loaded.

const PROJECT = '00000000-0000-4000-8000-000000000900';
const OTHER = '00000000-0000-4000-8000-000000000901';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';

function themeExtension(version: string, color = '#101010'): FixtureExtension {
  return {
    namespace: 'acme',
    name: 'night-theme',
    version,
    displayName: 'Acme Night',
    description: 'A dark theme',
    categories: ['Themes'],
    manifest: fixtureManifest('acme', 'night-theme', version, {
      displayName: 'Acme Night',
      contributes: {
        themes: [
          {
            id: 'acme-night',
            label: 'Acme Night',
            uiTheme: 'vs-dark',
            path: './themes/night.json',
          },
        ],
      },
    }),
    files: {
      'themes/base.json': JSON.stringify({ colors: { 'editor.foreground': '#eeeeee' } }),
      'themes/night.json': `{
        "include": "./base.json",
        // JSON with comments, as VS Code allows
        "colors": { "editor.background": "${color}" },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#6a9955" } }],
      }`,
    },
  };
}

const LANGUAGE: FixtureExtension = {
  namespace: 'acme',
  name: 'lang-acme',
  version: '0.3.0',
  displayName: 'Acme Language',
  categories: ['Programming Languages', 'Snippets'],
  manifest: fixtureManifest('acme', 'lang-acme', '0.3.0', {
    contributes: {
      languages: [
        {
          id: 'acme',
          aliases: ['Acme'],
          extensions: ['.acme'],
          configuration: './language-configuration.json',
        },
      ],
      grammars: [
        { language: 'acme', scopeName: 'source.acme', path: './syntaxes/acme.tmLanguage.json' },
      ],
      snippets: [{ language: 'acme', path: './snippets/acme.json' }],
    },
  }),
  files: {
    'language-configuration.json':
      '{ "comments": { "lineComment": "#" }, "brackets": [["{", "}"]], }',
    'syntaxes/acme.tmLanguage.json': JSON.stringify({
      scopeName: 'source.acme',
      patterns: [{ match: '#.*$', name: 'comment.line.acme' }],
    }),
    'snippets/acme.json': JSON.stringify({ Hello: { prefix: 'hello', body: 'hello ${1:world}' } }),
  },
};

const ICONS: FixtureExtension = {
  namespace: 'acme',
  name: 'icons',
  version: '2.0.0',
  manifest: fixtureManifest('acme', 'icons', '2.0.0', {
    contributes: {
      iconThemes: [{ id: 'acme-icons', label: 'Acme Icons', path: './icons/theme.json' }],
    },
  }),
  files: {
    'icons/theme.json': JSON.stringify({
      iconDefinitions: { file: { iconPath: './file.svg' }, ts: { iconPath: './ts.svg' } },
      file: 'file',
      fileExtensions: { ts: 'ts' },
    }),
    'icons/file.svg': SVG,
    'icons/ts.svg': SVG,
  },
};

const CODE_ONLY: FixtureExtension = {
  namespace: 'acme',
  name: 'code-only',
  version: '1.0.0',
  manifest: fixtureManifest('acme', 'code-only', '1.0.0', {
    main: './out/extension.js',
    contributes: { commands: [{ command: 'acme.run', title: 'Run' }] },
  }),
  files: { 'out/extension.js': 'throw new Error("must never run")' },
};

const DEPENDENT: FixtureExtension = {
  namespace: 'acme',
  name: 'night-snippets',
  version: '1.0.0',
  dependencies: ['acme.night-theme'],
  manifest: fixtureManifest('acme', 'night-snippets', '1.0.0', {
    extensionDependencies: ['acme.night-theme'],
    contributes: { snippets: [{ path: './s.json' }] },
  }),
  files: { 's.json': '{}' },
};

const hostile = (
  name: string,
  vsix: Buffer,
  extra: Partial<FixtureExtension> = {},
): FixtureExtension => ({
  namespace: 'evil',
  name,
  version: '1.0.0',
  manifest: fixtureManifest('evil', name, '1.0.0', {
    contributes: { snippets: [{ path: './s.json' }] },
  }),
  vsix,
  ...extra,
});

const pkg = (name: string) =>
  ({
    name: 'extension/package.json',
    data: JSON.stringify(
      fixtureManifest('evil', name, '1.0.0', { contributes: { snippets: [{ path: './s.json' }] } }),
    ),
  }) as const;

describe('Extensions Hub (SDD-015 Milestone A)', () => {
  let registry: FakeRegistry;
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let root: string;
  let service: ExtensionsService;
  let tested: TestedExtension[];

  beforeAll(async () => {
    registry = await startFakeRegistry();
    registry.add(themeExtension('1.0.0'));
    registry.add(LANGUAGE);
    registry.add(ICONS);
    registry.add(CODE_ONLY);
    registry.add(DEPENDENT);
    registry.add(
      hostile(
        'traversal',
        zip([pkg('traversal'), { name: 'extension/../../escape.txt', data: 'x' }]),
      ),
    );
    registry.add(
      hostile(
        'symlink',
        zip([pkg('symlink'), { name: 'extension/link', data: '/etc/passwd', mode: 0o120777 }]),
      ),
    );
    registry.add(
      hostile(
        'bomb',
        zip([
          pkg('bomb'),
          { name: 'extension/zeros.bin', data: Buffer.alloc(8 * 1024 * 1024), deflate: true },
        ]),
      ),
    );
    registry.add(
      hostile(
        'duplicate',
        zip([
          pkg('duplicate'),
          { name: 'extension/a.json', data: '1' },
          { name: 'extension/a.json', data: '2' },
        ]),
      ),
    );
    registry.add(
      hostile(
        'impostor',
        vsixOf({ ...themeExtension('1.0.0'), namespace: 'evil', name: 'impostor' }),
      ),
    );
    registry.add(hostile('tampered', zip([pkg('tampered')]), { sha256: 'f'.repeat(64) }));
    registry.add(hostile('no-manifest', zip([{ name: 'extension/readme.md', data: 'hi' }])));
    registry.add(hostile('not-zip', Buffer.from('this is not a zip archive')));
  });

  afterAll(async () => {
    await registry.close();
  });

  beforeEach(async () => {
    temp = createTempDir();
    root = path.join(temp.dir, 'extensions');
    db = openDatabase({ filePath: ':memory:' });
    const projects: [string, string][] = [
      [PROJECT, '/work/a'],
      [OTHER, '/work/b'],
    ];
    for (const [id, folder] of projects) {
      db.prepare(
        `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
           created_at, updated_at) VALUES (?, 'P', ?, ?, '[]', 0, 'x', 'x')`,
      ).run(id, folder, folder);
    }
    registry.down = false;
    tested = [];
    service = new ExtensionsService({
      repository: new SqliteExtensionRepository(db),
      registry: new OpenVsxRegistry(registry.url, 'ATLAS/test'),
      packages: new FileExtensionPackages(root),
      projectExists: async (id) => id === PROJECT || id === OTHER,
      platform: 'darwin-arm64',
      tested,
      clock: { now: () => new Date('2026-10-27T12:00:00.000Z') },
      logger: noopLogger,
    });
    await service.initialize();
  });

  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  const stagingIsEmpty = () => readdirSync(path.join(root, '.staging')).length === 0;

  it('searches by text, category and publisher', async () => {
    const byText = await service.search({ query: 'night' });
    expect(byText.extensions.map((item) => item.id)).toEqual([
      'acme.night-theme',
      'acme.night-snippets',
    ]);
    const byCategory = await service.search({ category: 'Themes' });
    expect(byCategory.extensions.map((item) => item.id)).toEqual(['acme.night-theme']);
    const byPublisher = await service.search({ publisher: 'acme', query: 'icons' });
    expect(byPublisher.extensions.map((item) => item.id)).toEqual(['acme.icons']);
  });

  it('shows details and compatibility before installing', async () => {
    const details = await service.details({ id: 'acme.code-only' });
    expect(details).toMatchObject({
      id: 'acme.code-only',
      platform: 'universal',
      installed: null,
      compatibility: { level: 'UNSUPPORTED', executable: true },
    });
    const theme = await service.details({ id: 'acme.night-theme' });
    expect(theme.compatibility).toMatchObject({
      level: 'UNTESTED',
      working: ['Color theme: Acme Night'],
    });
    expect(theme.license).toBe('MIT');
    await expect(service.details({ id: 'acme.missing' })).rejects.toMatchObject({
      code: 'EXTENSION_NOT_FOUND',
    });
  });

  it('installs a theme, resolves it, persists versions and uninstalls it', async () => {
    const installed = await service.install({ id: 'acme.night-theme' });
    expect(installed).toMatchObject({
      id: 'acme.night-theme',
      version: '1.0.0',
      enabled: true,
      activeHere: true,
      broken: false,
      contributes: { themes: 1 },
    });
    const folder = path.join(root, 'acme.night-theme', '1.0.0');
    expect(statSync(path.join(folder, 'themes', 'night.json')).isFile()).toBe(true);
    // Only extension/ is extracted, privately.
    expect(existsSync(path.join(folder, 'extension.vsixmanifest'))).toBe(false);
    expect(statSync(folder).mode & 0o077).toBe(0);
    expect(stagingIsEmpty()).toBe(true);

    const contributions = await service.contributions({ projectId: null });
    expect(contributions.themes).toEqual([
      {
        key: 'acme.night-theme/acme-night',
        extensionId: 'acme.night-theme',
        label: 'Acme Night',
        base: 'vs-dark',
      },
    ]);
    const theme = await service.theme('acme.night-theme/acme-night');
    expect(theme.colors).toEqual({
      'editor.foreground': '#eeeeee',
      'editor.background': '#101010',
    });
    expect(theme.tokenColors).toHaveLength(1);

    await service.uninstall('acme.night-theme');
    expect(await service.list({ projectId: null })).toEqual([]);
    expect(existsSync(path.join(root, 'acme.night-theme'))).toBe(false);
  });

  it('updates to a newer version, keeps settings and removes the old files', async () => {
    await service.install({ id: 'acme.night-theme' });
    await service.setEnabled({ id: 'acme.night-theme', projectId: PROJECT, enabled: false });
    registry.add(themeExtension('1.1.0', '#202020'));
    try {
      const check = await service.checkUpdates();
      expect(check.updates).toEqual([
        expect.objectContaining({
          id: 'acme.night-theme',
          installedVersion: '1.0.0',
          latestVersion: '1.1.0',
        }),
      ]);
      const updated = await service.install({ id: 'acme.night-theme' });
      expect(updated.version).toBe('1.1.0');
      expect(updated.projects).toEqual([{ projectId: PROJECT, enabled: false }]);
      expect(existsSync(path.join(root, 'acme.night-theme', '1.0.0'))).toBe(false);
      expect((await service.theme('acme.night-theme/acme-night')).colors['editor.background']).toBe(
        '#202020',
      );
      expect((await service.checkUpdates()).updates).toEqual([]);
      // An older version can be installed on request.
      expect((await service.install({ id: 'acme.night-theme', version: '1.0.0' })).version).toBe(
        '1.0.0',
      );
    } finally {
      registry.extensions.set('acme.night-theme', [themeExtension('1.0.0')]);
    }
  });

  it('applies global and per-project enablement without duplicating files', async () => {
    await service.install({ id: 'acme.lang-acme' });
    await service.setEnabled({ id: 'acme.lang-acme', projectId: PROJECT, enabled: false });
    expect((await service.contributions({ projectId: PROJECT })).languages).toEqual([]);
    expect((await service.contributions({ projectId: OTHER })).languages).toHaveLength(1);
    await service.setEnabled({ id: 'acme.lang-acme', projectId: null, enabled: false });
    expect((await service.contributions({ projectId: OTHER })).grammars).toEqual([]);
    await service.setEnabled({ id: 'acme.lang-acme', projectId: OTHER, enabled: true });
    expect((await service.contributions({ projectId: OTHER })).grammars).toHaveLength(1);
    await service.setEnabled({ id: 'acme.lang-acme', projectId: OTHER, enabled: null });
    expect((await service.contributions({ projectId: OTHER })).grammars).toEqual([]);
    expect(readdirSync(path.join(root, 'acme.lang-acme'))).toEqual(['0.3.0']);
    await expect(
      service.setEnabled({
        id: 'acme.lang-acme',
        projectId: '00000000-0000-4000-8000-000000000999',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('serves grammars, snippets and language configuration of a language extension', async () => {
    await service.install({ id: 'acme.lang-acme' });
    const contributions = await service.contributions({ projectId: PROJECT });
    expect(contributions.languages).toEqual([
      expect.objectContaining({ id: 'acme', extensions: ['.acme'], hasConfiguration: true }),
    ]);
    expect(contributions.grammars).toEqual([
      expect.objectContaining({
        extensionId: 'acme.lang-acme',
        language: 'acme',
        scopeName: 'source.acme',
      }),
    ]);
    const grammar = await service.grammar({
      extensionId: 'acme.lang-acme',
      scopeName: 'source.acme',
    });
    expect(grammar.format).toBe('json');
    expect(JSON.parse(grammar.content)).toMatchObject({ scopeName: 'source.acme' });
    expect(await service.snippets({ extensionId: 'acme.lang-acme', index: 0 })).toMatchObject({
      language: 'acme',
      snippets: [{ name: 'Hello', prefixes: ['hello'], body: 'hello ${1:world}' }],
      skipped: 0,
    });
    expect(
      await service.languageConfiguration({ extensionId: 'acme.lang-acme', language: 'acme' }),
    ).toEqual({
      comments: { lineComment: '#' },
      brackets: [['{', '}']],
    });
    await expect(
      service.grammar({ extensionId: 'acme.lang-acme', scopeName: 'source.other' }),
    ).rejects.toMatchObject({ code: 'EXTENSION_CONTRIBUTION_UNAVAILABLE' });
  });

  it('serves icon themes and SVG icons as data URIs', async () => {
    await service.install({ id: 'acme.icons' });
    const theme = await service.iconTheme('acme.icons/acme-icons');
    expect(theme).toMatchObject({
      file: 'file',
      fileExtensions: { ts: 'ts' },
      images: ['file', 'ts'],
    });
    expect(await service.icon({ theme: 'acme.icons/acme-icons', iconId: 'ts' })).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
    await expect(
      service.icon({ theme: 'acme.icons/acme-icons', iconId: 'nope' }),
    ).rejects.toMatchObject({
      code: 'EXTENSION_CONTRIBUTION_UNAVAILABLE',
    });
  });

  it('does not install an extension it cannot use and never runs its code', async () => {
    await expect(service.install({ id: 'acme.code-only' })).rejects.toMatchObject({
      code: 'EXTENSION_UNSUPPORTED',
    });
    expect(existsSync(path.join(root, 'acme.code-only'))).toBe(false);
    expect(service.diagnostics('acme.code-only')).toEqual([
      expect.objectContaining({ level: 'error', code: 'EXTENSION_UNSUPPORTED' }),
    ]);
  });

  it.each([
    ['traversal', 'EXTENSION_PACKAGE_INVALID'],
    ['symlink', 'EXTENSION_PACKAGE_INVALID'],
    ['bomb', 'EXTENSION_PACKAGE_INVALID'],
    ['duplicate', 'EXTENSION_PACKAGE_INVALID'],
    ['impostor', 'EXTENSION_IDENTITY_MISMATCH'],
    ['tampered', 'EXTENSION_CHECKSUM_MISMATCH'],
    ['no-manifest', 'EXTENSION_PACKAGE_INVALID'],
    ['not-zip', 'EXTENSION_PACKAGE_INVALID'],
  ])('refuses the %s package and leaves nothing behind', async (name, code) => {
    await expect(service.install({ id: `evil.${name}` })).rejects.toMatchObject({ code });
    expect(existsSync(path.join(root, `evil.${name}`))).toBe(false);
    expect(existsSync(path.join(temp.dir, 'escape.txt'))).toBe(false);
    expect(stagingIsEmpty()).toBe(true);
    expect(await service.list({ projectId: null })).toEqual([]);
  });

  it('enforces entry and size limits while extracting', async () => {
    const packages = new FileExtensionPackages(path.join(temp.dir, 'limited'), {
      entries: 3,
      totalBytes: 1024,
      fileBytes: 512,
      ratio: 100,
    });
    await packages.initialize([]);
    const file = await packages.stagingFile();
    writeFileSync(
      file,
      zip([pkg('many'), ...['a', 'b', 'c'].map((n) => ({ name: `extension/${n}`, data: n }))]),
    );
    await expect(packages.extract(file)).rejects.toMatchObject({
      code: 'EXTENSION_PACKAGE_INVALID',
    });
    writeFileSync(file, zip([pkg('big'), { name: 'extension/big.txt', data: 'x'.repeat(600) }]));
    await expect(packages.extract(file)).rejects.toMatchObject({
      code: 'EXTENSION_PACKAGE_TOO_LARGE',
    });
    await expect(packages.read('acme.x', '1.0.0', '../../etc/passwd', 100)).rejects.toMatchObject({
      code: 'EXTENSION_CONTRIBUTION_UNAVAILABLE',
    });
  });

  it('keeps working with installed extensions while the registry is down', async () => {
    await service.install({ id: 'acme.night-theme' });
    registry.down = true;
    await expect(service.search({ query: 'night' })).rejects.toMatchObject({
      code: 'EXTENSION_REGISTRY_UNAVAILABLE',
    });
    const check = await service.checkUpdates();
    expect(check).toMatchObject({ updates: [], failed: ['acme.night-theme'] });
    expect((await service.contributions({ projectId: null })).themes).toHaveLength(1);
    expect((await service.list({ projectId: null }))[0]).toMatchObject({ id: 'acme.night-theme' });
  });

  it('protects dependencies and reports missing ones', async () => {
    await service.install({ id: 'acme.night-theme' });
    await service.install({ id: 'acme.night-snippets' });
    await expect(service.uninstall('acme.night-theme')).rejects.toMatchObject({
      code: 'EXTENSION_REQUIRED_BY_OTHERS',
      issues: [{ field: 'dependents', message: 'night-snippets' }],
    });
    await service.uninstall('acme.night-snippets');
    await service.uninstall('acme.night-theme');

    await service.install({ id: 'acme.night-snippets' });
    expect((await service.list({ projectId: null }))[0]?.missingDependencies).toEqual([
      'acme.night-theme',
    ]);
    expect((await service.details({ id: 'acme.night-snippets' })).dependencies).toEqual([
      { id: 'acme.night-theme', installed: false },
    ]);
  });

  it('marks only matrix entries SUPPORTED', async () => {
    tested.push({
      id: 'acme.night-theme',
      extensionVersion: '1.0.0',
      platform: 'universal',
      atlasVersion: '0.30.0',
      testedAt: '2026-10-27',
      limitations: [],
    });
    expect((await service.details({ id: 'acme.night-theme' })).compatibility.level).toBe(
      'SUPPORTED',
    );
    expect((await service.details({ id: 'acme.lang-acme' })).compatibility.level).toBe('UNTESTED');
  });

  it('removes leftovers and reports installs whose files disappeared', async () => {
    await service.install({ id: 'acme.night-theme' });
    const orphan = path.join(root, 'acme.orphan', '1.0.0');
    const stale = path.join(root, 'acme.night-theme', '0.9.0');
    for (const folder of [orphan, stale, path.join(root, '.staging', 'half')]) {
      mkdirSync(folder, { recursive: true });
    }
    await service.initialize();
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(root, '.staging'))).toBe(false);
    expect(existsSync(path.join(root, 'acme.night-theme', '1.0.0'))).toBe(true);

    rmSync(path.join(root, 'acme.night-theme'), { recursive: true });
    expect((await service.list({ projectId: null }))[0]?.broken).toBe(true);
    expect((await service.contributions({ projectId: null })).themes).toEqual([]);
  });

  it('records contribution problems from the editor, without repeats', async () => {
    await service.install({ id: 'acme.lang-acme' });
    const problem = {
      extensionId: 'acme.lang-acme',
      code: 'GRAMMAR_FAILED',
      message: 'bad\nregex\u0007',
    } as const;
    service.reportProblem(problem);
    service.reportProblem(problem);
    expect(service.diagnostics('acme.lang-acme')).toEqual([
      expect.objectContaining({ code: 'GRAMMAR_FAILED', message: 'bad regex', level: 'warning' }),
    ]);
    expect((await service.list({ projectId: null }))[0]?.problems).toBe(1);
    expect(() => service.reportProblem({ ...problem, extensionId: 'acme.missing' })).toThrow();
    service.clearDiagnostics('acme.lang-acme');
    expect(service.diagnostics('acme.lang-acme')).toEqual([]);
  });

  it('refuses a second change to the same extension while one runs', async () => {
    const first = service.install({ id: 'acme.night-theme' });
    await expect(service.install({ id: 'acme.night-theme' })).rejects.toMatchObject({
      code: 'EXTENSION_BUSY',
    });
    await first;
  });

  it('only follows https links unless the registry itself is http', () => {
    const secure = new OpenVsxRegistry('https://open-vsx.example', 'ATLAS/test');
    return expect(secure.text('http://open-vsx.example/file', 10)).rejects.toMatchObject({
      code: 'EXTENSION_REGISTRY_INVALID_RESPONSE',
    });
  });

  it('names the platform like Open VSX', () => {
    expect(openVsxPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(openVsxPlatform('linux', 'x64')).toBe('linux-x64');
    expect(openVsxPlatform('linux', 'arm')).toBe('linux-armhf');
    expect(openVsxPlatform('win32', 'x64')).toBe('win32-x64');
  });
});
