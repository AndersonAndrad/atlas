import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_PROTOCOL_VERSION } from './protocol.js';

export const RUN_DIRECTORY_NAME = 'run';
export const RUN_FILE_NAME = 'engine.json';
/** macOS limits Unix socket paths to 104 bytes (Linux: 108); keep a safety margin. */
const MAX_UNIX_SOCKET_PATH = 100;

/** Contents of the run file. It is only readable by the current user (0600). */
export interface EngineRunInfo {
  protocol: number;
  pid: number;
  endpoint: string;
  token: string;
}

export function runDirectory(dataDir: string): string {
  return path.join(dataDir, RUN_DIRECTORY_NAME);
}

export function runFilePath(dataDir: string): string {
  return path.join(runDirectory(dataDir), RUN_FILE_NAME);
}

/** Creates the run directory, accessible only by the current user. */
export function ensureRunDirectory(dataDir: string, platform: NodeJS.Platform): string {
  const dir = runDirectory(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') chmodSync(dir, 0o700);
  return dir;
}

/**
 * Local endpoint of the Engine: a Unix domain socket inside the private run
 * directory, or a named pipe on Windows. Long data directories fall back to a
 * short per-data-directory socket name in the user's temporary directory.
 */
export function engineEndpoint(dataDir: string, platform: NodeJS.Platform): string {
  const hash = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\atlas-engine-${hash}`;
  const preferred = path.join(runDirectory(dataDir), 'engine.sock');
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH) return preferred;
  return path.join(os.tmpdir(), `atlas-${hash}.sock`);
}

export async function writeRunFile(dataDir: string, info: EngineRunInfo): Promise<void> {
  const target = runFilePath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(info), { mode: 0o600 });
  await rename(temporary, target);
}

export async function readRunFile(dataDir: string): Promise<EngineRunInfo | null> {
  let raw: string;
  try {
    raw = await readFile(runFilePath(dataDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<EngineRunInfo>;
    if (
      value.protocol !== ENGINE_PROTOCOL_VERSION ||
      typeof value.endpoint !== 'string' ||
      typeof value.token !== 'string' ||
      typeof value.pid !== 'number'
    ) {
      return null;
    }
    return value as EngineRunInfo;
  } catch {
    return null;
  }
}

export async function removeRunFile(dataDir: string, token: string): Promise<void> {
  // Only remove the file this Engine wrote; a newer Engine may have replaced it.
  const current = await readRunFile(dataDir);
  if (current?.token === token) await rm(runFilePath(dataDir), { force: true });
}
