import { describe, expect, it } from 'vitest';
import { ShellEnvironment, SystemShellProvider, type ShellFileSystem } from '../src/index.js';

function fakeFs(
  executables: Record<string, string>,
  files: Record<string, string> = {},
): ShellFileSystem {
  return {
    resolveExecutable: async (filePath) => executables[filePath] ?? null,
    readOptionalFile: async (filePath) => files[filePath] ?? null,
  };
}

const CONFIG = '/data/shells.json';

describe('SystemShellProvider', () => {
  it('detects zsh and bash on macOS as login shells with $SHELL as default', async () => {
    const provider = new SystemShellProvider({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      customShellsFile: CONFIG,
      fileSystem: fakeFs({ '/bin/zsh': '/bin/zsh', '/bin/bash': '/bin/bash' }),
    });
    const { shells, configurationIssues } = await provider.catalog(null);
    expect(shells.map((shell) => [shell.id, shell.path, shell.args, shell.isDefault])).toEqual([
      ['zsh', '/bin/zsh', ['-l'], true],
      ['bash', '/bin/bash', ['-l'], false],
    ]);
    expect(configurationIssues).toEqual([]);
  });

  it('does not assume shells exist and de-duplicates symlinks', async () => {
    const provider = new SystemShellProvider({
      platform: 'linux',
      env: { SHELL: '/usr/bin/bash' },
      customShellsFile: CONFIG,
      fileSystem: fakeFs({ '/usr/bin/bash': '/usr/bin/bash', '/bin/bash': '/usr/bin/bash' }),
    });
    const { shells } = await provider.catalog(null);
    expect(shells).toEqual([
      expect.objectContaining({ id: 'bash', path: '/usr/bin/bash', args: [], isDefault: true }),
    ]);
  });

  it('gives distinct stable ids to different installations of one shell', async () => {
    const provider = new SystemShellProvider({
      platform: 'darwin',
      env: {},
      customShellsFile: CONFIG,
      fileSystem: fakeFs({
        '/bin/bash': '/bin/bash',
        '/opt/homebrew/bin/bash': '/opt/homebrew/Cellar/bash',
      }),
    });
    const ids = (await provider.catalog(null)).shells.map((shell) => shell.id);
    expect(ids[0]).toBe('bash');
    expect(ids[1]).toMatch(/^bash-[0-9a-f]{8}$/);
    expect((await provider.catalog(null)).shells[1]!.id).toBe(ids[1]);
  });

  it('honors the preferred default when it is available', async () => {
    const provider = new SystemShellProvider({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      customShellsFile: CONFIG,
      fileSystem: fakeFs({ '/bin/zsh': '/bin/zsh', '/bin/bash': '/bin/bash' }),
    });
    const preferred = await provider.catalog('bash');
    expect(preferred.shells.find((shell) => shell.isDefault)?.id).toBe('bash');
    const missing = await provider.catalog('fish');
    expect(missing.shells.find((shell) => shell.isDefault)?.id).toBe('zsh');
  });

  it('detects PowerShell, Windows PowerShell and cmd on Windows', async () => {
    const provider = new SystemShellProvider({
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      customShellsFile: CONFIG,
      fileSystem: fakeFs({
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': 'ps',
        'C:\\Windows\\System32\\cmd.exe': 'cmd',
      }),
    });
    const { shells } = await provider.catalog(null);
    expect(shells.map((shell) => [shell.id, shell.name, shell.isDefault])).toEqual([
      ['powershell', 'PowerShell', true],
      ['windows-powershell', 'Windows PowerShell', false],
      ['command-prompt', 'Command Prompt', false],
    ]);
  });

  it('falls back to Windows PowerShell when PowerShell 7 is not installed', async () => {
    const provider = new SystemShellProvider({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      customShellsFile: CONFIG,
      fileSystem: fakeFs({
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': 'ps',
        'C:\\Windows\\System32\\cmd.exe': 'cmd',
      }),
    });
    const { shells } = await provider.catalog(null);
    expect(shells.find((shell) => shell.isDefault)?.name).toBe('Windows PowerShell');
  });

  it('adds valid custom shells (e.g. an explicit WSL launcher) and reports invalid ones', async () => {
    const provider = new SystemShellProvider({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      customShellsFile: CONFIG,
      fileSystem: fakeFs(
        { 'C:\\Windows\\System32\\cmd.exe': 'cmd', 'C:\\Windows\\System32\\wsl.exe': 'wsl' },
        {
          [CONFIG]: JSON.stringify({
            shells: [
              {
                id: 'wsl-ubuntu',
                name: 'WSL: Ubuntu',
                path: 'C:\\Windows\\System32\\wsl.exe',
                args: ['-d', 'Ubuntu'],
              },
              { id: 'relative', name: 'Relative', path: 'bash.exe' },
              { id: 'script', name: 'Script', path: 'C:\\tools\\run.bat' },
              { id: 'missing', name: 'Missing', path: 'C:\\nope\\x.exe' },
              { id: 'command-prompt', name: 'Clash', path: 'C:\\Windows\\System32\\wsl.exe' },
            ],
          }),
        },
      ),
    });
    const { shells, configurationIssues } = await provider.catalog(null);
    expect(shells.find((shell) => shell.id === 'wsl-ubuntu')).toMatchObject({
      source: 'custom',
      args: ['-d', 'Ubuntu'],
    });
    expect(configurationIssues).toEqual([
      'Shell "relative": the path must be absolute.',
      'Shell "script": the path must point to an .exe file.',
      'Shell "missing": the file does not exist or is not executable.',
      'Shell "command-prompt": the identifier is already in use.',
    ]);
  });

  it('reports malformed configuration files without failing', async () => {
    const make = (content: string) =>
      new SystemShellProvider({
        platform: 'linux',
        env: {},
        customShellsFile: CONFIG,
        fileSystem: fakeFs({ '/bin/bash': '/bin/bash' }, { [CONFIG]: content }),
      });
    expect((await make('{oops').catalog(null)).configurationIssues).toEqual([
      'shells.json is not valid JSON.',
    ]);
    const invalid = await make(
      JSON.stringify({ shells: [{ id: 'Bad Id', name: 'x', path: '/x' }] }),
    ).catalog(null);
    expect(invalid.configurationIssues[0]).toMatch(/^shells\.json: shells\.0\.id /);
    expect(invalid.shells.map((shell) => shell.id)).toEqual(['bash']);
  });
});

describe('ShellEnvironment', () => {
  it('removes Electron and Node internals and sets terminal capabilities', () => {
    const env = new ShellEnvironment({
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        TERM: 'dumb',
        UNDEFINED: undefined,
      },
      platform: 'darwin',
      appVersion: '0.2.0',
    }).shellEnvironment();
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'ATLAS',
      TERM_PROGRAM_VERSION: '0.2.0',
      LANG: 'en_US.UTF-8',
    });
  });

  it('keeps an existing locale', () => {
    const env = new ShellEnvironment({
      env: { LC_ALL: 'pt_BR.UTF-8' },
      platform: 'darwin',
      appVersion: '0.2.0',
    }).shellEnvironment();
    expect(env.LANG).toBeUndefined();
    expect(env.LC_ALL).toBe('pt_BR.UTF-8');
  });
});
