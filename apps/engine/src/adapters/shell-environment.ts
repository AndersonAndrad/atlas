import type { EnvironmentProvider } from '@atlas/terminal';

/** Variables that configure Electron or Node.js itself and must not leak into user shells. */
const BLOCKED_PREFIXES = ['ELECTRON_', 'CHROME_', 'VSCODE_'];
const BLOCKED_NAMES = new Set([
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_UNIQUE_ID',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
]);

export interface ShellEnvironmentOptions {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  appVersion: string;
}

/** Builds the environment of new shells from the Engine's environment. */
export class ShellEnvironment implements EnvironmentProvider {
  constructor(private readonly options: ShellEnvironmentOptions) {}

  shellEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.options.env)) {
      if (value === undefined) continue;
      if (BLOCKED_NAMES.has(name) || BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        continue;
      }
      env[name] = value;
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'ATLAS';
    env.TERM_PROGRAM_VERSION = this.options.appVersion;
    // Apps launched from the macOS Finder get no locale; shells then mangle UTF-8.
    if (this.options.platform === 'darwin' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
      env.LANG = 'en_US.UTF-8';
    }
    return env;
  }
}
