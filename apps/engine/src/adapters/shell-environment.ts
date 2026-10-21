import type { EnvironmentProvider, ShellEnvironmentTarget } from '@atlas/terminal';

/** Variables that configure Electron or Node.js itself and must not leak into user shells. */
const BLOCKED_PREFIXES = ['ELECTRON_', 'CHROME_', 'VSCODE_'];
/** Set per terminal by ATLAS; inherited values (ATLAS started from an ATLAS terminal) are dropped. */
const ATLAS_TERMINAL_VARIABLES = [
  'ATLAS_PROJECT_ID',
  'ATLAS_PROJECT_DIR',
  'ATLAS_PROJECT_CONFIG',
  'ATLAS_CONTEXT_FILE',
  'ATLAS_TERMINAL_ID',
  'ATLAS_EVENTS_DIR',
  'ATLAS_CHECKPOINT_FILE',
  'ATLAS_BIN',
  'ATLAS_ZDOTDIR',
  'ATLAS_USER_ZDOTDIR',
  'BASH_FUNC___atlas_path_first%%',
];
const BLOCKED_NAMES = new Set([
  ...ATLAS_TERMINAL_VARIABLES,
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_UNIQUE_ID',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
]);

/**
 * Variables ATLAS's own development tooling sets (`pnpm dev` runs electron-vite, which
 * sets NODE_ENV=development and NODE_ENV_ELECTRON_VITE). They describe ATLAS, not the
 * user's projects, and break tools such as `next build` in terminals, commit checks and
 * Git hooks. A NODE_ENV set by the user's shell profile is recreated by the shell.
 */
export function withoutDevToolingVariables<T extends Record<string, string | undefined>>(
  env: T,
): T {
  if (env.NODE_ENV_ELECTRON_VITE === undefined) return env;
  const { NODE_ENV: _nodeEnv, NODE_ENV_ELECTRON_VITE: _tooling, ...rest } = env;
  return rest as T;
}

export interface ShellEnvironmentOptions {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  appVersion: string;
  /** Extra variables for a specific terminal, applied last (e.g. ATLAS project config). */
  terminalVariables?: (
    terminal: ShellEnvironmentTarget,
    base: Record<string, string>,
  ) => Record<string, string>;
}

/** Builds the environment of new shells from the Engine's environment. */
export class ShellEnvironment implements EnvironmentProvider {
  constructor(private readonly options: ShellEnvironmentOptions) {}

  shellEnvironment(terminal?: ShellEnvironmentTarget): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(withoutDevToolingVariables(this.options.env))) {
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
    if (terminal !== undefined && this.options.terminalVariables) {
      Object.assign(env, this.options.terminalVariables(terminal, env));
    }
    return env;
  }
}
