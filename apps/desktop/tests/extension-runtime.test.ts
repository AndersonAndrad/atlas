import type { ResolvedColorTheme, ResolvedIconTheme } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import { iconIdFor } from '../src/renderer/src/extensions/runtime/icon-lookup';
import { toLanguageConfiguration } from '../src/renderer/src/extensions/runtime/language-configuration';
import { colorMapRules, tokenName } from '../src/renderer/src/extensions/runtime/textmate-colors';
import {
  builtInRawTheme,
  contributedRawTheme,
  matchScope,
  monacoTheme,
} from '../src/renderer/src/extensions/runtime/themes';

// Only the enum the conversion reads; Monaco itself needs a browser.
const monaco = {
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
} as unknown as Parameters<typeof toLanguageConfiguration>[1];

const theme: ResolvedColorTheme = {
  key: 'acme.theme/night',
  label: 'Night',
  base: 'vs-dark',
  colors: { 'editor.background': '#101010', 'editor.foreground': '#eeeeee' },
  tokenColors: [
    { scopes: ['comment'], foreground: '#00ff00', background: null, fontStyle: 'italic' },
    { scopes: ['keyword'], foreground: '#ff0000', background: null, fontStyle: null },
    { scopes: ['keyword.control'], foreground: '#ff00ff', background: null, fontStyle: null },
    { scopes: ['meta.tag string'], foreground: '#0000ff', background: null, fontStyle: null },
  ],
  unsupported: [],
};

describe('TextMate token names', () => {
  it('encodes the color index and font style of vscode-textmate metadata', () => {
    const metadata = (foreground: number, fontStyle: number) =>
      (foreground << 15) | (fontStyle << 11);
    expect(tokenName(metadata(5, 0))).toBe('tm.f5');
    expect(tokenName(metadata(12, 3))).toBe('tm.f12.s3');
  });

  it('defines a rule for every color and font style', () => {
    const rules = colorMapRules(['', '#FFFFFF', '#00ff00']);
    expect(rules).toContainEqual({ token: 'tm.f1', foreground: 'FFFFFF' });
    expect(rules).toContainEqual({
      token: 'tm.f2.s3',
      foreground: '00ff00',
      fontStyle: 'italic bold',
    });
    expect(rules).toContainEqual({
      token: 'tm.f2.s15',
      foreground: '00ff00',
      fontStyle: 'italic bold underline strikethrough',
    });
    expect(rules.some((rule) => rule.token.startsWith('tm.f0'))).toBe(false);
  });
});

describe('color themes', () => {
  it('matches the most specific scope selector', () => {
    expect(matchScope(theme.tokenColors, 'keyword.control.flow')?.foreground).toBe('#ff00ff');
    expect(matchScope(theme.tokenColors, 'keyword.operator')?.foreground).toBe('#ff0000');
    expect(matchScope(theme.tokenColors, 'string.quoted')?.foreground).toBe('#0000ff');
    expect(matchScope(theme.tokenColors, 'variable')).toBeNull();
  });

  it('maps a contributed theme to Monaco with editor colors and approximate token rules', () => {
    const data = monacoTheme(theme, [{ token: 'tm.f1', foreground: 'abcdef' }]);
    expect(data).toMatchObject({ base: 'vs-dark', inherit: true, colors: theme.colors });
    expect(data.rules).toContainEqual({
      token: 'comment',
      foreground: '00ff00',
      fontStyle: 'italic',
    });
    expect(data.rules).toContainEqual({ token: 'keyword', foreground: 'ff0000' });
    expect(data.rules).toContainEqual({ token: 'tm.f1', foreground: 'abcdef' });
  });

  it('builds TextMate themes with the editor colors as defaults', () => {
    const raw = contributedRawTheme(theme);
    expect(raw.settings[0]).toEqual({
      settings: { foreground: '#eeeeee', background: '#101010' },
    });
    expect(raw.settings).toHaveLength(5);
    expect(builtInRawTheme('light').settings[0]).toEqual({
      settings: { foreground: '#000000', background: '#ffffff' },
    });
  });
});

describe('language configuration', () => {
  it('maps the supported keys to Monaco', () => {
    const configuration = toLanguageConfiguration(
      {
        comments: { lineComment: '#', blockComment: ['/*', '*/'] },
        brackets: [['{', '}'], ['bad']],
        autoClosingPairs: [['(', ')'], { open: '"', close: '"', notIn: ['string'] }],
        surroundingPairs: [['[', ']']],
        folding: { offSide: true, markers: { start: '^\\s*#region', end: '^\\s*#endregion' } },
        wordPattern: { pattern: '[a-z]+', flags: 'gi' },
        indentationRules: { increaseIndentPattern: '\\{$', decreaseIndentPattern: '^\\}' },
        onEnterRules: [{ beforeText: '^\\s*#', action: { indent: 'none', appendText: '# ' } }],
      },
      monaco,
    );
    expect(configuration.comments).toEqual({ lineComment: '#', blockComment: ['/*', '*/'] });
    expect(configuration.brackets).toEqual([['{', '}']]);
    expect(configuration.autoClosingPairs).toEqual([
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
    ]);
    expect(configuration.surroundingPairs).toEqual([{ open: '[', close: ']' }]);
    expect(configuration.folding?.offSide).toBe(true);
    expect(configuration.folding?.markers?.start.test('  #region x')).toBe(true);
    // The global flag is dropped, as in VS Code.
    expect(configuration.wordPattern?.flags).toBe('i');
    expect(configuration.indentationRules?.increaseIndentPattern.test('if {')).toBe(true);
    expect(configuration.onEnterRules).toEqual([
      { beforeText: /^\s*#/, action: { indentAction: 0, appendText: '# ' } },
    ]);
  });

  it('throws on an invalid pattern so the problem is reported', () => {
    expect(() => toLanguageConfiguration({ wordPattern: '([a-z' }, monaco)).toThrow(SyntaxError);
  });
});

describe('file icon lookup', () => {
  const icons: ResolvedIconTheme = {
    key: 'acme.icons/icons',
    label: 'Icons',
    file: 'file',
    folder: 'folder',
    folderExpanded: 'folder-open',
    rootFolder: null,
    rootFolderExpanded: null,
    fileExtensions: { ts: 'ts', 'd.ts': 'dts' },
    fileNames: { 'package.json': 'npm' },
    folderNames: { src: 'src' },
    folderNamesExpanded: { src: 'src-open' },
    languageIds: {},
    images: [],
    unsupported: [],
  };

  it.each([
    ['Package.json', 'file', false, 'npm'],
    ['types.d.ts', 'file', false, 'dts'],
    ['main.ts', 'file', false, 'ts'],
    ['README', 'file', false, 'file'],
    ['src', 'directory', false, 'src'],
    ['src', 'directory', true, 'src-open'],
    ['lib', 'directory', true, 'folder-open'],
  ])('%s (%s, open: %s) uses %s', (name, kind, open, expected) => {
    expect(iconIdFor(icons, name, kind, open)).toBe(expected);
  });
});
