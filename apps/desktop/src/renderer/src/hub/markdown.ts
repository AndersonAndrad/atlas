import { NOTE_LINKS_MAX, NOTE_LINK_SCHEME } from '@atlas/contracts';

/** Schemes a note link may use; anything else (javascript:, data:, file:…) is dropped. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * URL filter of the Markdown preview (SDD-010 §9). Keeps web, e-mail and `atlas:` links
 * and in-page anchors; every other URL becomes empty, so it is rendered inert. Images are
 * never loaded (see `MarkdownPreview`).
 */
export function safeNoteUrl(url: string): string {
  const value = url.trim();
  if (value.startsWith('#')) return value;
  if (value.startsWith(NOTE_LINK_SCHEME)) return value;
  try {
    return SAFE_PROTOCOLS.has(new URL(value).protocol) ? value : '';
  } catch {
    // Relative URLs mean nothing inside the app.
    return '';
  }
}

/** Whether a link leaves the app (opened by the system after the Engine-side check). */
export function isExternalUrl(url: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Distinct `atlas:` link targets of Markdown text, in order, capped for one check. */
export function atlasLinks(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/\]\(\s*<?(atlas:[^\s)>]+)>?/g)) {
    found.add(match[1]!);
    if (found.size >= NOTE_LINKS_MAX) break;
  }
  return [...found];
}

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export type MarkdownAction = 'heading' | 'bold' | 'list' | 'checklist' | 'code' | 'link' | 'table';

const LINE_PREFIXES: Partial<Record<MarkdownAction, string>> = {
  heading: '## ',
  list: '- ',
  checklist: '- [ ] ',
};

const TABLE = '| Column | Column |\n| ------ | ------ |\n| Value  | Value  |\n';

/** Applies a toolbar action to the textarea text and selection (no side effects). */
export function applyMarkdownAction(action: MarkdownAction, edit: TextEdit): TextEdit {
  const { value, selectionStart: start, selectionEnd: end } = edit;
  const selected = value.slice(start, end);
  const replace = (text: string, from: number, to: number, select: [number, number]) => ({
    value: value.slice(0, from) + text + value.slice(to),
    selectionStart: from + select[0],
    selectionEnd: from + select[1],
  });

  const prefix = LINE_PREFIXES[action];
  if (prefix !== undefined) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const block = value.slice(lineStart, end);
    const prefixed = block
      .split('\n')
      .map((line) => prefix + line)
      .join('\n');
    return replace(prefixed, lineStart, end, [prefixed.length, prefixed.length]);
  }
  switch (action) {
    case 'bold': {
      const text = selected || 'bold text';
      return replace(`**${text}**`, start, end, [2, 2 + text.length]);
    }
    case 'code': {
      if (!selected.includes('\n') && selected !== '') {
        return replace(`\`${selected}\``, start, end, [1, 1 + selected.length]);
      }
      const body = selected || 'code';
      const lead = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
      return replace(`${lead}\`\`\`\n${body}\n\`\`\`\n`, start, end, [
        lead.length + 4,
        lead.length + 4 + body.length,
      ]);
    }
    case 'link': {
      const text = selected || 'link text';
      const url = 'https://';
      return replace(`[${text}](${url})`, start, end, [
        text.length + 3,
        text.length + 3 + url.length,
      ]);
    }
    case 'table': {
      const lead = start > 0 && value[start - 1] !== '\n' ? '\n\n' : '';
      return replace(`${lead}${TABLE}`, start, end, [lead.length + 2, lead.length + 8]);
    }
    default:
      return edit;
  }
}
