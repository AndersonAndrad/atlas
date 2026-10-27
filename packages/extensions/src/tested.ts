import type { TestedExtension } from './compatibility.js';

/**
 * The tested compatibility matrix (FR-1547, PLAN-043 Q4). An entry is added only after
 * the opt-in registry test installed and checked that exact version; nothing here is
 * extrapolated to other versions. Only extensions whose every contribution ATLAS applies
 * belong here.
 */
export const TESTED_EXTENSIONS: readonly TestedExtension[] = [
  {
    // Color themes "Dracula Theme" and "Dracula Theme Soft".
    id: 'dracula-theme.theme-dracula',
    extensionVersion: '2.25.1',
    platform: 'universal',
    atlasVersion: '0.30.0',
    testedAt: '2026-10-27',
    limitations: ['Semantic token colors are ignored; TextMate token colors apply.'],
  },
  {
    // 264 JavaScript and TypeScript snippets in 6 files, none skipped.
    id: 'xabikos.JavaScriptSnippets',
    extensionVersion: '1.8.0',
    platform: 'universal',
    atlasVersion: '0.30.0',
    testedAt: '2026-10-27',
    limitations: [],
  },
  {
    // Apache configuration language with its TextMate grammar.
    id: 'mrmlnc.vscode-apache',
    extensionVersion: '1.2.0',
    platform: 'universal',
    atlasVersion: '0.30.0',
    testedAt: '2026-10-27',
    limitations: [],
  },
];
