import path from 'node:path';
import type { AiProvider } from '@atlas/contracts';

/** A provider configuration directory found on this computer. */
export interface ProfileCandidate {
  providerId: AiProvider;
  directory: string;
  displayName: string;
}

/** `~/.<cli>` is the CLI default; `~/.<cli>-<name>` is a profile named `<name>`. */
const PROFILE_DIRECTORY = /^\.(claude|codex)(?:-([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/;

/** Environment variable each CLI reads its configuration directory from. */
export const PROFILE_ENV: Record<AiProvider, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Display name for a profile directory: `~/.claude-work` → "work", `~/.claude` →
 * "default"; any other folder keeps its own name.
 */
export function profileName(providerId: AiProvider, directory: string): string {
  const base = path.basename(directory);
  const match = PROFILE_DIRECTORY.exec(base);
  if (match !== null && match[1] === providerId) return match[2] ?? 'default';
  return base.replace(/^\./, '') || directory;
}

/**
 * Profile directories in the home folder that follow the CLI naming convention, plus the
 * directories the environment points at. `entries` are the home folder's directory names.
 */
export function detectProfiles(input: {
  home: string;
  entries: readonly string[];
  env: Record<string, string | undefined>;
}): ProfileCandidate[] {
  const found = new Map<string, ProfileCandidate>();
  const add = (providerId: AiProvider, directory: string) => {
    const resolved = path.resolve(directory);
    const key = `${providerId}\0${resolved}`;
    if (!found.has(key)) {
      found.set(key, {
        providerId,
        directory: resolved,
        displayName: profileName(providerId, resolved),
      });
    }
  };
  for (const entry of [...input.entries].sort()) {
    const match = PROFILE_DIRECTORY.exec(entry);
    if (match?.[1] !== undefined) add(match[1] as AiProvider, path.join(input.home, entry));
  }
  for (const providerId of Object.keys(PROFILE_ENV) as AiProvider[]) {
    const value = input.env[PROFILE_ENV[providerId]];
    if (value !== undefined && path.isAbsolute(value)) add(providerId, value);
  }
  return [...found.values()];
}

/** The directory a CLI uses when its environment variable is not set. */
export function defaultProfileDirectory(providerId: AiProvider, home: string): string {
  return path.join(home, `.${providerId}`);
}
