import type * as MonacoApi from 'monaco-editor';

type Monaco = typeof MonacoApi;

type Configuration = MonacoApi.languages.LanguageConfiguration;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPair = (value: unknown): value is [string, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'string' &&
  typeof value[1] === 'string';

const pairs = (value: unknown): [string, string][] =>
  Array.isArray(value) ? value.filter(isPair).slice(0, 100) : [];

/**
 * A regular expression from `language-configuration.json`: a string, or
 * `{ pattern, flags }`. VS Code ignores the global flag; so does ATLAS.
 */
function regex(value: unknown): RegExp | undefined {
  const source = typeof value === 'string' ? value : isRecord(value) ? value.pattern : undefined;
  if (typeof source !== 'string' || source.length > 2000) return undefined;
  const flags =
    isRecord(value) && typeof value.flags === 'string' ? value.flags.replace(/[^imsu]/g, '') : '';
  return new RegExp(source, flags);
}

function autoClosing(value: unknown): MonacoApi.languages.IAutoClosingPairConditional[] {
  if (!Array.isArray(value)) return [];
  const result: MonacoApi.languages.IAutoClosingPairConditional[] = [];
  for (const item of value.slice(0, 100)) {
    if (isPair(item)) {
      result.push({ open: item[0], close: item[1] });
    } else if (isRecord(item) && typeof item.open === 'string' && typeof item.close === 'string') {
      const notIn = Array.isArray(item.notIn)
        ? item.notIn.filter((entry): entry is string => typeof entry === 'string')
        : typeof item.notIn === 'string'
          ? [item.notIn]
          : undefined;
      result.push({ open: item.open, close: item.close, ...(notIn ? { notIn } : {}) });
    }
  }
  return result;
}

function onEnterRules(value: unknown, monaco: Monaco): MonacoApi.languages.OnEnterRule[] {
  if (!Array.isArray(value)) return [];
  const actions: Record<string, MonacoApi.languages.IndentAction> = {
    none: monaco.languages.IndentAction.None,
    indent: monaco.languages.IndentAction.Indent,
    indentOutdent: monaco.languages.IndentAction.IndentOutdent,
    outdent: monaco.languages.IndentAction.Outdent,
  };
  const rules: MonacoApi.languages.OnEnterRule[] = [];
  for (const item of value.slice(0, 100)) {
    if (!isRecord(item) || !isRecord(item.action)) continue;
    const beforeText = regex(item.beforeText);
    const indentAction = actions[String(item.action.indent)];
    if (beforeText === undefined || indentAction === undefined) continue;
    const afterText = regex(item.afterText);
    const previousLineText = regex(item.previousLineText);
    rules.push({
      beforeText,
      ...(afterText ? { afterText } : {}),
      ...(previousLineText ? { previousLineText } : {}),
      action: {
        indentAction,
        ...(typeof item.action.appendText === 'string'
          ? { appendText: item.action.appendText }
          : {}),
        ...(typeof item.action.removeText === 'number'
          ? { removeText: item.action.removeText }
          : {}),
      },
    });
  }
  return rules;
}

/**
 * Maps a contributed `language-configuration.json` to Monaco (FR-1511): comments,
 * brackets, auto-closing and surrounding pairs, folding markers, word pattern,
 * indentation and on-enter rules. Other keys are ignored. Throws on an invalid pattern.
 */
export function toLanguageConfiguration(
  raw: Record<string, unknown>,
  monaco: Monaco,
): Configuration {
  const configuration: Configuration = {};
  if (isRecord(raw.comments)) {
    const { lineComment, blockComment } = raw.comments;
    configuration.comments = {
      ...(typeof lineComment === 'string' ? { lineComment } : {}),
      ...(isPair(blockComment) ? { blockComment } : {}),
    };
  }
  if (raw.brackets !== undefined) configuration.brackets = pairs(raw.brackets);
  if (raw.colorizedBracketPairs !== undefined) {
    configuration.colorizedBracketPairs = pairs(raw.colorizedBracketPairs);
  }
  if (raw.autoClosingPairs !== undefined) {
    configuration.autoClosingPairs = autoClosing(raw.autoClosingPairs);
  }
  if (raw.surroundingPairs !== undefined) {
    configuration.surroundingPairs = autoClosing(raw.surroundingPairs).map(({ open, close }) => ({
      open,
      close,
    }));
  }
  if (typeof raw.autoCloseBefore === 'string') configuration.autoCloseBefore = raw.autoCloseBefore;
  if (isRecord(raw.folding)) {
    const markers = isRecord(raw.folding.markers) ? raw.folding.markers : null;
    const start = markers ? regex(markers.start) : undefined;
    const end = markers ? regex(markers.end) : undefined;
    configuration.folding = {
      ...(typeof raw.folding.offSide === 'boolean' ? { offSide: raw.folding.offSide } : {}),
      ...(start && end ? { markers: { start, end } } : {}),
    };
  }
  const wordPattern = regex(raw.wordPattern);
  if (wordPattern) configuration.wordPattern = wordPattern;
  if (isRecord(raw.indentationRules)) {
    const rules = raw.indentationRules;
    const increaseIndentPattern = regex(rules.increaseIndentPattern);
    const decreaseIndentPattern = regex(rules.decreaseIndentPattern);
    if (increaseIndentPattern && decreaseIndentPattern) {
      const indentNextLinePattern = regex(rules.indentNextLinePattern);
      const unIndentedLinePattern = regex(rules.unIndentedLinePattern);
      configuration.indentationRules = {
        increaseIndentPattern,
        decreaseIndentPattern,
        ...(indentNextLinePattern ? { indentNextLinePattern } : {}),
        ...(unIndentedLinePattern ? { unIndentedLinePattern } : {}),
      };
    }
  }
  if (raw.onEnterRules !== undefined)
    configuration.onEnterRules = onEnterRules(raw.onEnterRules, monaco);
  return configuration;
}
