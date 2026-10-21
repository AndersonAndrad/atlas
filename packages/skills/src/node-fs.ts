import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { SkillIssue } from '@atlas/contracts';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, type SkillFolderSnapshot } from './analyze.js';
import type { SkillFileSystem } from './ports.js';

/** Never part of a skill: VCS data, OS metadata and ATLAS's own marker. */
const IGNORED = new Set(['.git', '.DS_Store', 'node_modules', '.atlas-managed.json']);
/** Text files up to this size are checked for credentials. */
const TEXT_CHECK_BYTES = 256 * 1024;

const isBinary = (buffer: Buffer) => buffer.subarray(0, 8000).includes(0);

/** Node.js file access for the Skills Hub. Paths are never executed. */
export class NodeSkillFileSystem implements SkillFileSystem {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async snapshot(directory: string): Promise<SkillFolderSnapshot> {
    const root = await realpath(directory);
    const files: SkillFolderSnapshot['files'] = [];
    const texts: SkillFolderSnapshot['texts'] = [];
    const problems: SkillIssue[] = [];
    let skillMd: string | null = null;
    let openaiYaml: string | null = null;
    let total = 0;
    let stopped = false;

    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(path.join(root, relative), { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (stopped) return;
        if (IGNORED.has(entry.name)) continue;
        const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const absolute = path.join(root, rel);
        if (entry.isSymbolicLink()) {
          const target = await realpath(absolute).catch(() => null);
          const inside =
            target !== null && (target === root || target.startsWith(`${root}${path.sep}`));
          problems.push(
            inside
              ? {
                  level: 'info',
                  code: 'link-skipped',
                  message: `${rel} is a link and is not copied.`,
                }
              : {
                  level: 'error',
                  code: 'link-outside',
                  message: `${rel} links outside the skill folder.`,
                },
          );
          continue;
        }
        if (entry.isDirectory()) {
          await walk(rel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.length >= MAX_SKILL_FILES || total > MAX_SKILL_BYTES) {
          stopped = true;
          problems.push({
            level: 'error',
            code: 'limits',
            message: `The folder has more than ${MAX_SKILL_FILES} files or 5 MB; reading stopped.`,
          });
          return;
        }
        const info = await stat(absolute);
        total += info.size;
        if (total > MAX_SKILL_BYTES) continue;
        const content = await readFile(absolute);
        const hash = createHash('sha256').update(content).digest('hex');
        files.push({
          path: rel,
          size: info.size,
          hash,
          mode: process.platform === 'win32' ? 0 : info.mode,
          head: content.subarray(0, 64).toString('utf8'),
        });
        if (rel === 'SKILL.md') skillMd = content.toString('utf8');
        else if (rel === 'agents/openai.yaml') openaiYaml = content.toString('utf8');
        else if (info.size <= TEXT_CHECK_BYTES && !isBinary(content)) {
          texts.push({ path: rel, content: content.toString('utf8') });
        }
      }
    };
    await walk('');
    if (total > MAX_SKILL_BYTES && !problems.some((problem) => problem.code === 'limits')) {
      problems.push({ level: 'error', code: 'limits', message: 'The folder is larger than 5 MB.' });
    }
    return { dirName: path.basename(root), files, skillMd, openaiYaml, texts, problems };
  }

  async skillFolders(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const folder = path.join(root, entry.name);
      if ((await this.kind(path.join(folder, 'SKILL.md'))) === 'file') folders.push(folder);
    }
    return folders.sort();
  }

  async copyFiles(from: string, to: string, files: readonly string[]): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const file of files) {
      const destination = path.join(to, ...file.split('/'));
      if (!destination.startsWith(`${to}${path.sep}`)) throw new Error('Invalid skill file path.');
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(from, ...file.split('/')), destination);
    }
  }

  async writeFile(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }

  async readText(file: string, maxBytes: number) {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      const content = buffer.subarray(0, Math.min(bytesRead, maxBytes));
      return isBinary(content)
        ? { content: null, truncated: false }
        : { content: content.toString('utf8'), truncated: bytesRead > maxBytes };
    } finally {
      await handle.close();
    }
  }

  async kind(target: string) {
    try {
      const info = await stat(target);
      return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    } catch {
      return null;
    }
  }

  realpath(target: string): Promise<string> {
    return realpath(target);
  }

  async move(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  }

  async removeDirectory(directory: string): Promise<void> {
    // Never follows links: a linked folder is unlinked, not emptied.
    const info = await lstat(directory).catch(() => null);
    if (info === null) return;
    await rm(directory, { recursive: true, force: true });
  }

  hasExecutable(name: string): boolean | null {
    if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null;
    const extensions =
      process.platform === 'win32' ? (this.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    for (const directory of (this.env.PATH ?? '').split(path.delimiter)) {
      if (directory === '') continue;
      for (const extension of extensions) {
        try {
          accessSync(path.join(directory, name + extension), constants.X_OK);
          return true;
        } catch {
          // not here
        }
      }
    }
    return false;
  }
}
