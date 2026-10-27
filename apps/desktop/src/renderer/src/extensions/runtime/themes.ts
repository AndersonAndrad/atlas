import type { ColorThemeBase, ResolvedColorTheme, TokenColorRule } from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import type { IRawTheme } from 'vscode-textmate';

type Rule = Pick<TokenColorRule, 'foreground' | 'fontStyle'> & { scopes: string[] };

const rule = (scopes: string, foreground: string, fontStyle: string | null = null): Rule => ({
  scopes: scopes.split(','),
  foreground,
  fontStyle,
});

/** Token colors used with ATLAS's own themes when a contributed grammar is active. */
const DARK_TOKENS: Rule[] = [
  rule('comment,punctuation.definition.comment', '#6a9955'),
  rule('string,meta.embedded.assembly', '#ce9178'),
  rule('string.regexp', '#d16969'),
  rule('constant.character.escape', '#d7ba7d'),
  rule('constant.numeric', '#b5cea8'),
  rule('constant.language,variable.language,storage,storage.type,keyword', '#569cd6'),
  rule('keyword.control,keyword.other.import,keyword.control.import', '#c586c0'),
  rule('keyword.operator', '#d4d4d4'),
  rule('entity.name.function,support.function', '#dcdcaa'),
  rule('entity.name.type,entity.name.class,support.type,support.class', '#4ec9b0'),
  rule('variable,meta.definition.variable.name,support.variable', '#9cdcfe'),
  rule('entity.name.tag', '#569cd6'),
  rule('entity.other.attribute-name', '#9cdcfe'),
  rule('punctuation.definition.tag', '#808080'),
  rule('markup.heading', '#569cd6', 'bold'),
  rule('markup.bold', '#d4d4d4', 'bold'),
  rule('markup.italic', '#d4d4d4', 'italic'),
  rule('invalid', '#f44747'),
];

const LIGHT_TOKENS: Rule[] = [
  rule('comment,punctuation.definition.comment', '#008000'),
  rule('string,meta.embedded.assembly', '#a31515'),
  rule('string.regexp', '#811f3f'),
  rule('constant.character.escape', '#ee0000'),
  rule('constant.numeric', '#098658'),
  rule('constant.language,variable.language,storage,storage.type,keyword', '#0000ff'),
  rule('keyword.control,keyword.other.import,keyword.control.import', '#af00db'),
  rule('keyword.operator', '#000000'),
  rule('entity.name.function,support.function', '#795e26'),
  rule('entity.name.type,entity.name.class,support.type,support.class', '#267f99'),
  rule('variable,meta.definition.variable.name,support.variable', '#001080'),
  rule('entity.name.tag', '#800000'),
  rule('entity.other.attribute-name', '#e50000'),
  rule('markup.heading', '#800000', 'bold'),
  rule('markup.bold', '#000000', 'bold'),
  rule('markup.italic', '#000000', 'italic'),
  rule('invalid', '#cd3131'),
];

export const BUILT_IN_THEMES = {
  dark: { name: 'atlas-dark', base: 'vs-dark', foreground: '#d4d4d4', background: '#0a0a0a' },
  light: { name: 'atlas-light', base: 'vs', foreground: '#000000', background: '#ffffff' },
  'high-contrast': {
    name: 'atlas-high-contrast',
    base: 'hc-black',
    foreground: '#ffffff',
    background: '#000000',
  },
} as const;

/** The TextMate theme for one of ATLAS's own editor themes. */
export function builtInRawTheme(theme: keyof typeof BUILT_IN_THEMES): IRawTheme {
  const { foreground, background } = BUILT_IN_THEMES[theme];
  const rules = theme === 'light' ? LIGHT_TOKENS : DARK_TOKENS;
  return {
    settings: [
      { settings: { foreground, background } },
      ...rules.map((item) => ({
        scope: item.scopes,
        settings: {
          ...(item.foreground ? { foreground: item.foreground } : {}),
          ...(item.fontStyle ? { fontStyle: item.fontStyle } : {}),
        },
      })),
    ],
  };
}

/** A contributed theme in vscode-textmate's format. */
export function contributedRawTheme(theme: ResolvedColorTheme): IRawTheme {
  const foreground = theme.colors['editor.foreground'];
  const background = theme.colors['editor.background'];
  return {
    settings: [
      {
        settings: {
          ...(foreground ? { foreground } : {}),
          ...(background ? { background } : {}),
        },
      },
      ...theme.tokenColors.map((item) => ({
        ...(item.scopes.length > 0 ? { scope: item.scopes } : {}),
        settings: {
          ...(item.foreground ? { foreground: item.foreground } : {}),
          ...(item.background ? { background: item.background } : {}),
          ...(item.fontStyle !== null ? { fontStyle: item.fontStyle } : {}),
        },
      })),
    ],
  };
}

/**
 * Monaco's own tokenizers name tokens `keyword`, `string`, `type`… rather than TextMate
 * scopes, so each gets the color its closest TextMate scope has (PLAN-043 R5).
 */
const MONARCH_SCOPES: [string, string[]][] = [
  ['comment', ['comment']],
  ['string', ['string']],
  ['string.escape', ['constant.character.escape']],
  ['keyword', ['keyword', 'storage.type']],
  ['number', ['constant.numeric']],
  ['regexp', ['string.regexp']],
  ['type', ['entity.name.type', 'support.type']],
  ['type.identifier', ['entity.name.type', 'entity.name.class']],
  ['identifier', ['variable']],
  ['variable', ['variable']],
  ['variable.predefined', ['variable.language']],
  ['constant', ['constant.language']],
  ['predefined', ['support.function']],
  ['delimiter', ['punctuation']],
  ['operator', ['keyword.operator']],
  ['tag', ['entity.name.tag']],
  ['attribute.name', ['entity.other.attribute-name']],
  ['attribute.value', ['string']],
  ['metatag', ['entity.name.tag']],
  ['annotation', ['storage.type.annotation', 'entity.name.function.decorator']],
  ['invalid', ['invalid']],
];

/** The token rule whose selector best matches a scope (longest prefix wins). */
export function matchScope(rules: readonly TokenColorRule[], scope: string): TokenColorRule | null {
  let best: TokenColorRule | null = null;
  let bestLength = -1;
  for (const item of rules) {
    for (const selector of item.scopes) {
      // Only the last part of a descendant selector ("meta.tag string") is compared.
      const last = selector.trim().split(/\s+/).pop() ?? '';
      if ((scope === last || scope.startsWith(`${last}.`)) && last.length >= bestLength) {
        best = item;
        bestLength = last.length;
      }
    }
  }
  return best;
}

const hex = (color: string) => color.replace('#', '');

/** A contributed color theme as a Monaco theme (FR-1507). */
export function monacoTheme(
  theme: ResolvedColorTheme,
  textMateRules: readonly MonacoApi.editor.ITokenThemeRule[],
): MonacoApi.editor.IStandaloneThemeData {
  const rules: MonacoApi.editor.ITokenThemeRule[] = [];
  for (const [token, scopes] of MONARCH_SCOPES) {
    for (const scope of scopes) {
      const match = matchScope(theme.tokenColors, scope);
      if (match === null) continue;
      rules.push({
        token,
        ...(match.foreground ? { foreground: hex(match.foreground) } : {}),
        ...(match.fontStyle ? { fontStyle: match.fontStyle } : {}),
      });
      break;
    }
  }
  return {
    base: monacoBase(theme.base),
    inherit: true,
    rules: [...rules, ...textMateRules],
    colors: theme.colors,
  };
}

function monacoBase(base: ColorThemeBase): MonacoApi.editor.BuiltinTheme {
  return base === 'hc-light' ? 'hc-light' : base;
}
