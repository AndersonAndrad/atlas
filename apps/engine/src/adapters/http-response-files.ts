import { chmod, copyFile, mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HttpResponseFiles } from '@atlas/api-workbench';

/**
 * Response bodies of the API Workbench, kept in private files while a window shows them
 * (§19): large responses never have to fit in memory, and nothing outlives the Engine.
 */
export class FileHttpResponses implements HttpResponseFiles {
  constructor(private readonly directory: string) {}

  async allocate(executionId: string): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const file = path.join(this.directory, `${path.basename(executionId)}.body`);
    await writeFile(file, '', { mode: 0o600, flag: 'wx' });
    return file;
  }

  async read(file: string, offset: number, limit: number): Promise<Uint8Array> {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async copyTo(file: string, destination: string): Promise<void> {
    await copyFile(file, destination);
  }

  async remove(file: string): Promise<void> {
    await rm(file, { force: true });
  }

  async removeAll(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}
