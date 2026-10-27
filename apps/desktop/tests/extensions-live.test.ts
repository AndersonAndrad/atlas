import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionsService, TESTED_EXTENSIONS } from '@atlas/extensions';
import { SqliteExtensionRepository, openDatabase, type Database } from '@atlas/persistence';
import { noopLogger } from '@atlas/shared';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';
import { createTempDir } from '../../../tests/support/temp.js';
import { FileExtensionPackages } from '../../engine/src/adapters/extension-packages.js';
import { OPEN_VSX_URL, OpenVsxRegistry } from '../../engine/src/adapters/open-vsx-registry.js';
import { openVsxPlatform } from '../../engine/src/engine.js';

/**
 * The tested compatibility matrix (FR-1547, PLAN-043 Q4) against the real Open VSX. Opt-in:
 * `ATLAS_LIVE_OPEN_VSX=1 pnpm vitest run apps/desktop/tests/extensions-live.test.ts`.
 * Exact versions only; a new version needs a new run before it can be called SUPPORTED.
 */
const live = process.env.ATLAS_LIVE_OPEN_VSX === '1';

describe.skipIf(!live)('Open VSX compatibility matrix (live)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let service: ExtensionsService;

  beforeAll(async () => {
    temp = createTempDir();
    db = openDatabase({ filePath: ':memory:' });
    service = new ExtensionsService({
      repository: new SqliteExtensionRepository(db),
      registry: new OpenVsxRegistry(OPEN_VSX_URL, 'ATLAS/compatibility-test'),
      packages: new FileExtensionPackages(path.join(temp.dir, 'extensions')),
      projectExists: async () => false,
      platform: openVsxPlatform(process.platform, process.arch),
      tested: TESTED_EXTENSIONS,
      clock: { now: () => new Date() },
      logger: noopLogger,
    });
    await service.initialize();
    const require = createRequire(import.meta.url);
    const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length));
  }, 30_000);

  afterAll(() => {
    db?.close();
    temp?.cleanup();
  });

  it('dracula-theme.theme-dracula 2.25.1: color theme', async () => {
    const installed = await service.install({
      id: 'dracula-theme.theme-dracula',
      version: '2.25.1',
    });
    expect(installed.compatibility).toMatchObject({ level: 'SUPPORTED', executable: false });
    const { themes } = await service.contributions({ projectId: null });
    expect(themes.length).toBeGreaterThan(0);
    for (const theme of themes) {
      const resolved = await service.theme(theme.key);
      expect(resolved.colors['editor.background']).toMatch(/^#[0-9a-f]{6,8}$/);
      expect(resolved.tokenColors.length).toBeGreaterThan(20);
      expect(resolved.unsupported).toEqual(['Semantic token colors']);
    }
  }, 60_000);

  it('xabikos.JavaScriptSnippets 1.8.0: snippets', async () => {
    const installed = await service.install({ id: 'xabikos.JavaScriptSnippets', version: '1.8.0' });
    expect(installed.compatibility).toMatchObject({ level: 'SUPPORTED', unsupported: [] });
    const { snippets } = await service.contributions({ projectId: null });
    const files = snippets.filter((item) => item.extensionId === 'xabikos.javascriptsnippets');
    expect(files.length).toBeGreaterThan(0);
    let total = 0;
    for (const file of files) {
      const resolved = await service.snippets({ extensionId: file.extensionId, index: file.index });
      total += resolved.snippets.length;
      expect(resolved.skipped).toBe(0);
    }
    expect(total).toBeGreaterThan(20);
    expect([files.length, total]).toEqual([6, 264]);
  }, 60_000);

  it('mrmlnc.vscode-apache 1.2.0: language and TextMate grammar', async () => {
    const installed = await service.install({ id: 'mrmlnc.vscode-apache', version: '1.2.0' });
    expect(installed.compatibility).toMatchObject({ level: 'SUPPORTED', unsupported: [] });
    const { languages, grammars } = await service.contributions({ projectId: null });
    const grammar = grammars.find((item) => item.extensionId === 'mrmlnc.vscode-apache');
    expect(grammar).toBeDefined();
    expect(languages.find((item) => item.id === grammar?.language)).toBeDefined();
    const source = await service.grammar({
      extensionId: 'mrmlnc.vscode-apache',
      scopeName: grammar!.scopeName,
    });
    // The same tokenizer and regex engine the editor uses.
    const registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (text: string) => new oniguruma.OnigString(text),
      }),
      loadGrammar: async (scope) =>
        scope === grammar!.scopeName
          ? textmate.parseRawGrammar(
              source.content,
              source.format === 'json' ? 'g.json' : 'g.tmLanguage',
            )
          : null,
    });
    const loaded = await registry.loadGrammar(grammar!.scopeName);
    const line = loaded!.tokenizeLine('# A comment', textmate.INITIAL);
    expect(line.tokens.flatMap((token) => token.scopes).join(' ')).toContain('comment');
  }, 60_000);

  it('PKief.material-icon-theme 5.40.0: icons only (its code does not run)', async () => {
    const installed = await service.install({ id: 'PKief.material-icon-theme', version: '5.40.0' });
    expect(installed.compatibility).toMatchObject({
      level: 'PARTIALLY_SUPPORTED',
      executable: true,
    });
    const { iconThemes } = await service.contributions({ projectId: null });
    const key = iconThemes.find((item) => item.extensionId === 'pkief.material-icon-theme')?.key;
    expect(key).toBeDefined();
    const theme = await service.iconTheme(key!);
    expect(theme.images.length).toBeGreaterThan(100);
    const iconId = theme.fileExtensions.ts ?? theme.file;
    expect(await service.icon({ theme: key!, iconId: iconId! })).toMatch(/^data:image\/svg\+xml/);
    expect(theme.unsupported).toEqual(['Light and high contrast icon variants']);
  }, 120_000);
});
