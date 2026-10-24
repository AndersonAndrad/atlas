import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '../src/renderer/src/hub/components/MarkdownPreview.js';
import {
  applyMarkdownAction,
  atlasLinks,
  isExternalUrl,
  safeNoteUrl,
} from '../src/renderer/src/hub/markdown.js';

const render = (markdown: string) =>
  renderToStaticMarkup(
    createElement(MarkdownPreview, {
      markdown,
      links: new Map([
        ['atlas:note/broken', { href: 'atlas:note/broken', valid: false, label: null }],
      ]),
      onOpenLink: () => undefined,
      onOpenExternal: () => undefined,
    }),
  );

describe('note Markdown (SDD-010 FR-1003, §9)', () => {
  it('renders GitHub-flavoured Markdown', () => {
    const html = render(
      '# Title\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<table>');
    expect(html).toContain('const a = 1;');
  });

  it('never renders raw HTML, scripts, event handlers or dangerous URLs', () => {
    const html = render(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(1)">',
        '<iframe src="https://example.com"></iframe>',
        '[js](javascript:alert(1))',
        '[data](data:text/html;base64,PHNjcmlwdD4=)',
        '[file](file:///etc/passwd)',
        '![tracker](https://example.com/pixel.png)',
        '[web](https://example.com)',
      ].join('\n\n'),
    );
    expect(html).not.toMatch(/<script|<iframe|onerror|javascript:|data:text|file:\/\//i);
    expect(html).not.toContain('<img');
    expect(html).toContain('Image: tracker');
    expect(html).toContain('href="https://example.com"');
  });

  it('marks broken internal links and keeps valid ones clickable', () => {
    const html = render('[gone](atlas:note/broken) and [open](atlas:session/x)');
    expect(html).toContain('data-testid="note-broken-link"');
    expect(html).toContain('href="atlas:session/x"');
  });

  it('filters URLs and finds internal links', () => {
    expect(safeNoteUrl('https://a.dev/x')).toBe('https://a.dev/x');
    expect(safeNoteUrl(' JavaScript:alert(1)')).toBe('');
    expect(safeNoteUrl('relative/path')).toBe('');
    expect(safeNoteUrl('#section')).toBe('#section');
    expect(isExternalUrl('mailto:a@b.dev')).toBe(true);
    expect(isExternalUrl('atlas:note/x')).toBe(false);
    expect(
      atlasLinks('[a](atlas:note/1) [b](<atlas:file/a.md>) [a](atlas:note/1) [c](https://x)'),
    ).toEqual(['atlas:note/1', 'atlas:file/a.md']);
  });

  it('applies toolbar actions to the selection', () => {
    expect(
      applyMarkdownAction('checklist', { value: 'a\nb', selectionStart: 0, selectionEnd: 3 }),
    ).toEqual({ value: '- [ ] a\n- [ ] b', selectionStart: 15, selectionEnd: 15 });
    expect(
      applyMarkdownAction('bold', { value: 'x word y', selectionStart: 2, selectionEnd: 6 }),
    ).toEqual({ value: 'x **word** y', selectionStart: 4, selectionEnd: 8 });
    const code = applyMarkdownAction('code', { value: 'text', selectionStart: 4, selectionEnd: 4 });
    expect(code.value).toBe('text\n```\ncode\n```\n');
    expect(code.value.slice(code.selectionStart, code.selectionEnd)).toBe('code');
    const link = applyMarkdownAction('link', { value: 'see', selectionStart: 0, selectionEnd: 3 });
    expect(link.value).toBe('[see](https://)');
    expect(link.value.slice(link.selectionStart, link.selectionEnd)).toBe('https://');
    const table = applyMarkdownAction('table', { value: '', selectionStart: 0, selectionEnd: 0 });
    expect(table.value.startsWith('| Column |')).toBe(true);
  });
});
