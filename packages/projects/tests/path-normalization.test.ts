import { describe, expect, it } from 'vitest';
import {
  directoryName,
  isAbsoluteForPlatform,
  normalizeAbsolutePath,
  toPathKey,
  toPathPlatform,
} from '../src/index.js';

describe('toPathKey', () => {
  it('treats macOS paths as case-insensitive', () => {
    expect(toPathKey('/Users/Dev/Atlas', 'darwin')).toBe(toPathKey('/users/dev/atlas', 'darwin'));
  });

  it('treats macOS Unicode composed and decomposed forms as the same directory', () => {
    const composed = '/Users/dev/proje\u00e7\u00e3o';
    const decomposed = '/Users/dev/projec\u0327a\u0303o';
    expect(toPathKey(composed, 'darwin')).toBe(toPathKey(decomposed, 'darwin'));
  });

  it('treats Linux paths as case-sensitive', () => {
    expect(toPathKey('/home/dev/Atlas', 'linux')).not.toBe(toPathKey('/home/dev/atlas', 'linux'));
  });

  it('treats Windows paths as case-insensitive with either separator', () => {
    expect(toPathKey('C:\\Work\\Atlas', 'win32')).toBe(toPathKey('c:/work/atlas', 'win32'));
  });

  it('ignores trailing separators and dot segments', () => {
    expect(toPathKey('/home/dev/atlas/', 'linux')).toBe('/home/dev/atlas');
    expect(toPathKey('/home/dev/./x/../atlas', 'linux')).toBe('/home/dev/atlas');
    expect(toPathKey('C:\\Work\\Atlas\\', 'win32')).toBe('c:\\work\\atlas');
  });

  it('strips Windows long-path prefixes', () => {
    expect(toPathKey('\\\\?\\C:\\Work\\Atlas', 'win32')).toBe(
      toPathKey('C:\\Work\\Atlas', 'win32'),
    );
    expect(toPathKey('\\\\?\\UNC\\server\\share\\atlas', 'win32')).toBe(
      toPathKey('\\\\server\\share\\atlas', 'win32'),
    );
  });

  it('keeps filesystem roots intact', () => {
    expect(normalizeAbsolutePath('/', 'linux')).toBe('/');
    expect(normalizeAbsolutePath('c:\\', 'win32')).toBe('C:\\');
  });
});

describe('platform helpers', () => {
  it('detects absolute paths per platform', () => {
    expect(isAbsoluteForPlatform('/a', 'linux')).toBe(true);
    expect(isAbsoluteForPlatform('relative/a', 'darwin')).toBe(false);
    expect(isAbsoluteForPlatform('C:\\a', 'win32')).toBe(true);
    expect(isAbsoluteForPlatform('C:\\a', 'linux')).toBe(false);
  });

  it('maps unknown POSIX platforms to Linux semantics', () => {
    expect(toPathPlatform('freebsd')).toBe('linux');
    expect(toPathPlatform('darwin')).toBe('darwin');
  });

  it('derives the directory name', () => {
    expect(directoryName('/home/dev/atlas/', 'linux')).toBe('atlas');
    expect(directoryName('C:\\Work\\Atlas', 'win32')).toBe('Atlas');
  });
});
