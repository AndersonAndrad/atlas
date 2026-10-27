import type * as MonacoApi from 'monaco-editor';

// Bit layout of vscode-textmate's encoded token metadata.
const FONT_STYLE_MASK = 0b0000_0000_0000_0000_0111_1000_0000_0000;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0b0000_0000_1111_1111_1000_0000_0000_0000;
const FOREGROUND_OFFSET = 15;

/** Monaco token names that carry vscode-textmate's resolved color and font style. */
export function tokenName(metadata: number): string {
  const foreground = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
  const fontStyle = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
  return fontStyle === 0 ? `tm.f${foreground}` : `tm.f${foreground}.s${fontStyle}`;
}

const FONT_STYLES: [number, string][] = [
  [1, 'italic'],
  [2, 'bold'],
  [4, 'underline'],
  [8, 'strikethrough'],
];

/** Monaco theme rules for every color the TextMate theme uses (see `tokenName`). */
export function colorMapRules(colorMap: readonly string[]): MonacoApi.editor.ITokenThemeRule[] {
  const rules: MonacoApi.editor.ITokenThemeRule[] = [];
  colorMap.forEach((color, index) => {
    if (index === 0 || !color) return;
    const foreground = color.replace('#', '');
    rules.push({ token: `tm.f${index}`, foreground });
    for (let style = 1; style < 16; style += 1) {
      const fontStyle = FONT_STYLES.filter(([bit]) => (style & bit) !== 0)
        .map(([, name]) => name)
        .join(' ');
      rules.push({ token: `tm.f${index}.s${style}`, foreground, fontStyle });
    }
  });
  return rules;
}
