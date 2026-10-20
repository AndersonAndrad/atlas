import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CustomShellsFileSchema,
  type CustomShell,
  type ShellCatalog,
  type ShellOption,
} from '@atlas/contracts';
import type { ShellProvider } from '@atlas/terminal';
import { describeError, noopLogger, type Logger } from '@atlas/shared';

export const CUSTOM_SHELLS_FILE_NAME = 'shells.json';

/** Filesystem access used by shell detection; replaceable in tests. */
export interface ShellFileSystem {
  /** Resolves to the canonical path of an executable regular file, or null. */
  resolveExecutable(filePath: string): Promise<string | null>;
  /** Resolves to the file content, or null when it does not exist. */
  readOptionalFile(filePath: string): Promise<string | null>;
}

export interface SystemShellProviderOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Path of the optional custom shells configuration file. */
  customShellsFile: string;
  fileSystem?: ShellFileSystem;
  logger?: Logger;
}

interface Candidate {
  name: string;
  path: string;
  args: string[];
}

/**
 * Detects the shells installed on this machine plus the ones configured in
 * shells.json. Only shells that exist and are executable are offered.
 */
export class SystemShellProvider implements ShellProvider {
  private readonly fs: ShellFileSystem;
  private readonly logger: Logger;

  constructor(private readonly options: SystemShellProviderOptions) {
    this.fs = options.fileSystem ?? nodeShellFileSystem;
    this.logger = options.logger ?? noopLogger;
  }

  async catalog(preferredId: string | null): Promise<ShellCatalog> {
    const shells: ShellOption[] = [];
    const seenPaths = new Set<string>();
    const usedIds = new Set<string>();

    for (const candidate of this.systemCandidates()) {
      const resolved = await this.fs.resolveExecutable(candidate.path);
      if (resolved === null || seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const id = uniqueId(shellIdFromName(candidate.name), resolved, usedIds);
      shells.push({
        id,
        name: candidate.name,
        // Keep the conventional path (e.g. /bin/zsh) for display and spawning.
        path: candidate.path,
        args: candidate.args,
        source: 'system',
        isDefault: false,
      });
    }

    const { shells: custom, issues } = await this.customShells(usedIds);
    shells.push(...custom);
    markDefault(shells, preferredId, this.defaultSystemShellId(shells));
    return { shells, configurationIssues: issues };
  }

  private systemCandidates(): Candidate[] {
    const { platform, env } = this.options;
    if (platform === 'win32') return windowsCandidates(env);

    // Login shells on macOS load the user's PATH even when ATLAS was opened from Finder.
    const args = platform === 'darwin' ? ['-l'] : [];
    const candidates: Candidate[] = [];
    const userShell = env.SHELL;
    if (userShell && path.isAbsolute(userShell)) {
      candidates.push({ name: path.basename(userShell), path: userShell, args });
    }
    for (const name of platform === 'darwin' ? ['zsh', 'bash'] : ['bash', 'zsh']) {
      for (const dir of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
        candidates.push({ name, path: `${dir}/${name}`, args });
      }
    }
    return candidates;
  }

  /** $SHELL on macOS/Linux; PowerShell 7, then Windows PowerShell, then cmd on Windows. */
  private defaultSystemShellId(shells: ShellOption[]): string | undefined {
    const system = shells.filter((shell) => shell.source === 'system');
    return system[0]?.id;
  }

  private async customShells(
    usedIds: Set<string>,
  ): Promise<{ shells: ShellOption[]; issues: string[] }> {
    const file = this.options.customShellsFile;
    let raw: string | null;
    try {
      raw = await this.fs.readOptionalFile(file);
    } catch (error) {
      this.logger.warn('Custom shell configuration could not be read', {
        error: describeError(error),
      });
      return { shells: [], issues: [`${CUSTOM_SHELLS_FILE_NAME} could not be read.`] };
    }
    if (raw === null) return { shells: [], issues: [] };

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { shells: [], issues: [`${CUSTOM_SHELLS_FILE_NAME} is not valid JSON.`] };
    }
    const parsed = CustomShellsFileSchema.safeParse(json);
    if (!parsed.success) {
      return {
        shells: [],
        issues: parsed.error.issues.map(
          (issue) => `${CUSTOM_SHELLS_FILE_NAME}: ${issue.path.join('.') || '_'} ${issue.message}`,
        ),
      };
    }

    const shells: ShellOption[] = [];
    const issues: string[] = [];
    for (const entry of parsed.data.shells) {
      const issue = await this.validateCustomShell(entry, usedIds);
      if (issue !== null) {
        issues.push(`Shell "${entry.id}": ${issue}`);
        continue;
      }
      usedIds.add(entry.id);
      shells.push({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        args: entry.args,
        source: 'custom',
        isDefault: false,
      });
    }
    return { shells, issues };
  }

  private async validateCustomShell(
    entry: CustomShell,
    usedIds: Set<string>,
  ): Promise<string | null> {
    if (usedIds.has(entry.id)) return 'the identifier is already in use.';
    const isAbsolute =
      this.options.platform === 'win32'
        ? path.win32.isAbsolute(entry.path)
        : path.posix.isAbsolute(entry.path);
    if (!isAbsolute) return 'the path must be absolute.';
    if (this.options.platform === 'win32' && !/\.exe$/i.test(entry.path)) {
      return 'the path must point to an .exe file.';
    }
    if ((await this.fs.resolveExecutable(entry.path)) === null) {
      return 'the file does not exist or is not executable.';
    }
    return null;
  }
}

function windowsCandidates(env: Record<string, string | undefined>): Candidate[] {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const candidates: Candidate[] = [
    {
      name: 'PowerShell',
      path: path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      args: ['-NoLogo'],
    },
    {
      name: 'Windows PowerShell',
      path: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'],
    },
  ];
  const comSpec = env.ComSpec ?? env.COMSPEC;
  candidates.push({
    name: 'Command Prompt',
    path:
      comSpec && /\.exe$/i.test(comSpec)
        ? comSpec
        : path.win32.join(systemRoot, 'System32', 'cmd.exe'),
    args: [],
  });
  return candidates;
}

function shellIdFromName(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 48);
  return id === '' ? 'shell' : id;
}

/** Stable ids: the first shell with a name gets it; others get a path-derived suffix. */
function uniqueId(base: string, resolvedPath: string, used: Set<string>): string {
  let id = base;
  if (used.has(id)) {
    id = `${base}-${createHash('sha256').update(resolvedPath).digest('hex').slice(0, 8)}`;
  }
  used.add(id);
  return id;
}

function markDefault(
  shells: ShellOption[],
  preferredId: string | null,
  fallbackId: string | undefined,
): void {
  const preferred = shells.find((shell) => shell.id === preferredId);
  const chosen = preferred ?? shells.find((shell) => shell.id === fallbackId) ?? shells[0];
  if (chosen) chosen.isDefault = true;
}

export const nodeShellFileSystem: ShellFileSystem = {
  async resolveExecutable(filePath) {
    try {
      const resolved = await realpath(filePath);
      const info = await stat(resolved);
      if (!info.isFile()) return null;
      if (process.platform !== 'win32') await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      return null;
    }
  },
  async readOptionalFile(filePath) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
};
