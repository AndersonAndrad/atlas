import { describe, expect, it } from 'vitest';
import { AtlasError } from '@atlas/shared';
import {
  compareVersions,
  declarationsOf,
  evaluateCompatibility,
  iconDataUri,
  isSupportedSnippetBody,
  parseManifest,
  readGrammar,
  resolveColorTheme,
  resolveIconTheme,
  resolveLanguageConfiguration,
  resolveSnippets,
  safeRelativePath,
  type ExtensionFileReader,
  type TestedExtension,
} from '../src/index.js';

const encoder = new TextEncoder();

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ publisher: 'acme', name: 'pack', version: '1.2.3', ...extra });
}

function reader(files: Record<string, string | Uint8Array>): ExtensionFileReader {
  return async (relativePath, maxBytes) => {
    const content = files[relativePath];
    if (content === undefined) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    if (bytes.length > maxBytes) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    return bytes;
  };
}

describe('parseManifest', () => {
  it('reads identity, code entry points and only the supported contributions', () => {
    const parsed = parseManifest(
      manifest({
        displayName: 'Acme Pack',
        main: './out/extension.js',
        license: { type: 'MIT' },
        extensionDependencies: ['acme.base', 'not valid'],
        contributes: { themes: [], commands: [{ command: 'x' }] },
      }),
    );
    expect(parsed).toMatchObject({
      publisher: 'acme',
      name: 'pack',
      version: '1.2.3',
      displayName: 'Acme Pack',
      main: './out/extension.js',
      browser: null,
      license: 'MIT',
      extensionDependencies: ['acme.base'],
      contributionKeys: ['themes', 'commands'],
    });
    expect(parsed.contributes).toEqual({ themes: [] });
  });

  it('accepts comments and trailing commas like VS Code', () => {
    const parsed = parseManifest(
      '{ // comment\n "publisher": "acme", "name": "pack", "version": "1.0.0", }',
    );
    expect(parsed.name).toBe('pack');
  });

  it.each([
    ['no publisher', JSON.stringify({ name: 'x', version: '1.0.0' })],
    ['a path as name', manifest({ name: '../evil' })],
    ['an invalid version', manifest({ version: 'latest' })],
    ['an array', '[]'],
    ['broken JSON', '{"publisher":'],
  ])('rejects a manifest with %s', (_case, content) => {
    expect(() => parseManifest(content)).toThrow(
      expect.objectContaining({ code: 'EXTENSION_PACKAGE_INVALID' }),
    );
  });
});

describe('safeRelativePath', () => {
  it.each([
    ['./themes/dark.json', '', 'themes/dark.json'],
    ['dark.json', 'themes', 'themes/dark.json'],
    ['../base.json', 'themes/sub', 'themes/base.json'],
  ])('resolves %s from %s', (value, base, expected) => {
    expect(safeRelativePath(value, base)).toBe(expected);
  });

  it.each(['../outside.json', '/etc/passwd', 'C:/x', 'a\\b', 'a\0b', '', './', 42])(
    'refuses %s',
    (value) => {
      expect(safeRelativePath(value)).toBeNull();
    },
  );

  it('refuses climbing above the extension from a nested base', () => {
    expect(safeRelativePath('../../x.json', 'themes')).toBeNull();
  });
});

describe('declarationsOf', () => {
  it('keeps valid entries and drops malformed or escaping ones', () => {
    const declared = declarationsOf(
      parseManifest(
        manifest({
          contributes: {
            languages: [
              { id: 'acme', extensions: ['.acme'], configuration: './lang.json' },
              { id: 'bad id!' },
            ],
            grammars: [
              { language: 'acme', scopeName: 'source.acme', path: './syntax.json' },
              { scopeName: 'source.evil', path: '../../evil.json' },
            ],
            themes: [
              { label: 'Acme Dark', uiTheme: 'vs-dark', path: './dark.json' },
              { label: 'No path' },
            ],
            iconThemes: [{ id: 'acme-icons', label: 'Acme Icons', path: './icons.json' }],
            snippets: [{ language: 'acme', path: './snippets.json' }, { path: './all.json' }],
          },
        }),
      ),
    );
    expect(declared.languages).toEqual([
      expect.objectContaining({ id: 'acme', extensions: ['.acme'], configuration: 'lang.json' }),
    ]);
    expect(declared.grammars).toEqual([
      expect.objectContaining({ scopeName: 'source.acme', path: 'syntax.json' }),
    ]);
    expect(declared.themes).toEqual([
      { id: 'Acme Dark', label: 'Acme Dark', base: 'vs-dark', path: 'dark.json' },
    ]);
    expect(declared.iconThemes).toHaveLength(1);
    expect(declared.snippets).toEqual([
      { index: 0, language: 'acme', path: 'snippets.json' },
      { index: 1, language: null, path: 'all.json' },
    ]);
  });
});

describe('evaluateCompatibility', () => {
  const declarative = parseManifest(
    manifest({
      contributes: {
        themes: [{ label: 'Acme Dark', uiTheme: 'vs-dark', path: './dark.json' }],
        snippets: [{ language: 'acme', path: './s.json' }],
      },
    }),
  );

  it('calls a fully declarative extension UNTESTED, never SUPPORTED, without a test', () => {
    const result = evaluateCompatibility(declarative, [], 'darwin-arm64');
    expect(result.level).toBe('UNTESTED');
    expect(result.executable).toBe(false);
    expect(result.working).toEqual(['Color theme: Acme Dark', 'Snippets: acme']);
    expect(result.unsupported).toEqual([]);
    expect(result.tested).toBeNull();
  });

  it('uses SUPPORTED only for the exact tested version and platform', () => {
    const tested: TestedExtension[] = [
      {
        id: 'Acme.Pack',
        extensionVersion: '1.2.3',
        platform: 'universal',
        atlasVersion: '0.30.0',
        testedAt: '2026-10-27',
        limitations: ['Semantic colors are ignored.'],
      },
    ];
    const result = evaluateCompatibility(declarative, tested, 'linux-x64');
    expect(result.level).toBe('SUPPORTED');
    expect(result.tested).toMatchObject({ extensionVersion: '1.2.3', atlasVersion: '0.30.0' });
    expect(result.notes).toContain('Semantic colors are ignored.');
    const other = parseManifest(
      manifest({ version: '1.2.4', contributes: declarative.contributes }),
    );
    expect(evaluateCompatibility(other, tested, 'linux-x64').level).toBe('UNTESTED');
  });

  it('marks code and unknown contribution points as unsupported', () => {
    const result = evaluateCompatibility(
      parseManifest(
        manifest({
          main: './extension.js',
          contributes: {
            grammars: [{ language: 'acme', scopeName: 'source.acme', path: './g.json' }],
            commands: [],
            debuggers: [],
            mystery: {},
          },
        }),
      ),
      [],
      'darwin-arm64',
    );
    expect(result.level).toBe('PARTIALLY_SUPPORTED');
    expect(result.executable).toBe(true);
    expect(result.working).toEqual(['Syntax highlighting: acme']);
    expect(result.unsupported).toEqual([
      'Extension code (commands, language features and anything it runs)',
      'Commands',
      'Debuggers',
      'Contribution "mystery"',
    ]);
  });

  it('calls an extension with nothing usable UNSUPPORTED', () => {
    const result = evaluateCompatibility(
      parseManifest(manifest({ main: './extension.js', contributes: { commands: [] } })),
      [],
      'darwin-arm64',
    );
    expect(result.level).toBe('UNSUPPORTED');
  });

  it('does not count TextMate (plist) themes as working', () => {
    const result = evaluateCompatibility(
      parseManifest(
        manifest({ contributes: { themes: [{ label: 'Old', path: './old.tmTheme' }] } }),
      ),
      [],
      'darwin-arm64',
    );
    expect(result.level).toBe('UNSUPPORTED');
    expect(result.unsupported).toEqual(['Color theme in TextMate format: Old']);
  });

  it('explains extension packs and dependencies', () => {
    const result = evaluateCompatibility(
      parseManifest(
        manifest({
          extensionPack: ['acme.one'],
          extensionDependencies: ['acme.base'],
          contributes: { snippets: [{ path: './s.json' }] },
        }),
      ),
      [],
      'darwin-arm64',
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([
        'This is an extension pack: install the extensions it lists one by one.',
        'Needs: acme.base.',
      ]),
    );
  });
});

describe('resolveColorTheme', () => {
  it('merges included themes, keeps valid colors and token rules, and lists the rest', async () => {
    const files = reader({
      'themes/base.json': JSON.stringify({
        colors: { 'editor.background': '#111111', 'editor.foreground': '#EEEEEE' },
        tokenColors: [{ scope: 'comment', settings: { foreground: '#00ff00' } }],
      }),
      'themes/dark.json': `{
        // comments are allowed
        "include": "./base.json",
        "colors": { "editor.background": "#222222", "bad": "red", "list.x": "#zzz" },
        "tokenColors": [
          { "scope": "keyword, storage", "settings": { "foreground": "#FF0000", "fontStyle": "bold" } },
          { "scope": "nothing", "settings": {} },
        ],
        "semanticHighlighting": true,
      }`,
    });
    const theme = await resolveColorTheme(files, {
      key: 'acme.pack/dark',
      label: 'Dark',
      base: 'vs-dark',
      path: 'themes/dark.json',
    });
    expect(theme.colors).toEqual({
      'editor.background': '#222222',
      'editor.foreground': '#eeeeee',
    });
    expect(theme.tokenColors).toEqual([
      { scopes: ['comment'], foreground: '#00ff00', background: null, fontStyle: null },
      {
        scopes: ['keyword', 'storage'],
        foreground: '#ff0000',
        background: null,
        fontStyle: 'bold',
      },
    ]);
    expect(theme.unsupported).toEqual(['Semantic token colors']);
  });

  it('refuses includes that leave the extension or loop forever', async () => {
    await expect(
      resolveColorTheme(reader({ 'a.json': '{"include":"../../x.json"}' }), {
        key: 'k/a',
        label: 'A',
        base: 'vs',
        path: 'a.json',
      }),
    ).rejects.toMatchObject({ code: 'EXTENSION_CONTRIBUTION_UNAVAILABLE' });
    await expect(
      resolveColorTheme(reader({ 'a.json': '{"include":"./a.json"}' }), {
        key: 'k/a',
        label: 'A',
        base: 'vs',
        path: 'a.json',
      }),
    ).rejects.toMatchObject({ code: 'EXTENSION_CONTRIBUTION_UNAVAILABLE' });
  });
});

describe('readGrammar', () => {
  it('returns JSON and plist grammars and refuses anything else', async () => {
    const files = reader({
      'g.json': '{"scopeName":"source.acme","patterns":[]}',
      'g.tmLanguage': '<?xml version="1.0"?><plist></plist>',
      'bad.json': '{',
      'bad.tmLanguage': 'not xml',
    });
    await expect(readGrammar(files, 'g.json')).resolves.toMatchObject({ format: 'json' });
    await expect(readGrammar(files, 'g.tmLanguage')).resolves.toMatchObject({ format: 'plist' });
    await expect(readGrammar(files, 'bad.json')).rejects.toBeInstanceOf(AtlasError);
    await expect(readGrammar(files, 'bad.tmLanguage')).rejects.toBeInstanceOf(AtlasError);
  });
});

describe('snippets', () => {
  it.each([
    ['log(${1:value})$0', true],
    ['${1|a,b|} ${TM_FILENAME}', true],
    ['\\${not a placeholder', true],
    ['${1:open', false],
  ])('checks %s', (body, supported) => {
    expect(isSupportedSnippetBody(body)).toBe(supported);
  });

  it('loads valid snippets and counts the ones it skips', async () => {
    const result = await resolveSnippets(
      reader({
        's.json': JSON.stringify({
          Log: { prefix: ['log', 'cl'], body: ['console.log(${1});', '$0'], description: 'Log' },
          Scoped: { prefix: 'sc', body: 'x', scope: 'javascript, typescript' },
          Broken: { prefix: 'br', body: '${1:oops' },
          NoPrefix: { body: 'x' },
          NotAnObject: 'x',
        }),
      }),
      { path: 's.json', language: null },
    );
    expect(result.snippets).toEqual([
      {
        name: 'Log',
        prefixes: ['log', 'cl'],
        body: 'console.log(${1});\n$0',
        description: 'Log',
        scopes: null,
      },
      {
        name: 'Scoped',
        prefixes: ['sc'],
        body: 'x',
        description: null,
        scopes: ['javascript', 'typescript'],
      },
    ]);
    expect(result.skipped).toBe(3);
  });
});

describe('resolveLanguageConfiguration', () => {
  it('keeps only the keys the editor maps', async () => {
    const result = await resolveLanguageConfiguration(
      reader({
        'lang.json': '{ "comments": { "lineComment": "#" }, "brackets": [["(", ")"]], "x": 1, }',
      }),
      'lang.json',
    );
    expect(result).toEqual({ comments: { lineComment: '#' }, brackets: [['(', ')']] });
  });
});

describe('icon themes', () => {
  it('maps image icons, ignores font icons and unknown ids', async () => {
    const { theme, imagePaths } = await resolveIconTheme(
      reader({
        'icons/theme.json': JSON.stringify({
          iconDefinitions: {
            file: { iconPath: './file.svg' },
            ts: { iconPath: '../images/ts.png' },
            folder: { fontCharacter: '\\E001' },
            escape: { iconPath: '../../outside.svg' },
          },
          file: 'file',
          folder: 'folder',
          fileExtensions: { TS: 'ts', js: 'missing' },
          fileNames: { 'Package.json': 'file' },
          light: {},
        }),
      }),
      { key: 'acme.pack/icons', label: 'Icons', path: 'icons/theme.json' },
    );
    expect(theme.file).toBe('file');
    expect(theme.folder).toBeNull();
    expect(theme.fileExtensions).toEqual({ ts: 'ts' });
    expect(theme.fileNames).toEqual({ 'package.json': 'file' });
    expect([...imagePaths]).toEqual([
      ['file', 'icons/file.svg'],
      ['ts', 'images/ts.png'],
    ]);
    expect(theme.unsupported).toEqual(
      expect.arrayContaining([
        'Font icons',
        'Icons that are not SVG or PNG files',
        'Light and high contrast icon variants',
      ]),
    );
  });

  it('returns data URIs only for real SVG and PNG content', () => {
    expect(iconDataUri('a.svg', encoder.encode('<svg xmlns="x"></svg>'))).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(iconDataUri('a.png', png)).toMatch(/^data:image\/png;base64,/);
    expect(() => iconDataUri('a.svg', encoder.encode('<html></html>'))).toThrow(AtlasError);
    expect(() => iconDataUri('a.png', encoder.encode('<svg></svg>'))).toThrow(AtlasError);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '2.0.0', 0],
    ['1.0.0-beta', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0+build', '1.0.0', 0],
  ])('%s vs %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
