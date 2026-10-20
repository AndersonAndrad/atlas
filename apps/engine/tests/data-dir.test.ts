import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/index.js';

describe('resolveDataDir', () => {
  it('uses Application Support on macOS', () => {
    expect(resolveDataDir({ env: {}, platform: 'darwin', homeDir: '/Users/dev' })).toBe(
      '/Users/dev/Library/Application Support/ATLAS',
    );
  });

  it('uses APPDATA on Windows', () => {
    expect(
      resolveDataDir({
        env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
        platform: 'win32',
        homeDir: 'C:\\Users\\dev',
      }),
    ).toBe('C:\\Users\\dev\\AppData\\Roaming\\ATLAS');
  });

  it('uses XDG_DATA_HOME on Linux and falls back to ~/.local/share', () => {
    expect(
      resolveDataDir({ env: { XDG_DATA_HOME: '/data' }, platform: 'linux', homeDir: '/home/dev' }),
    ).toBe('/data/atlas');
    expect(
      resolveDataDir({
        env: { XDG_DATA_HOME: 'relative' },
        platform: 'linux',
        homeDir: '/home/dev',
      }),
    ).toBe('/home/dev/.local/share/atlas');
  });

  it('honors the ATLAS_DATA_DIR override', () => {
    expect(
      resolveDataDir({ env: { ATLAS_DATA_DIR: '/tmp/atlas' }, platform: 'darwin', homeDir: '/x' }),
    ).toBe(path.resolve('/tmp/atlas'));
  });
});
