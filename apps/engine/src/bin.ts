#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { describeError, toSerializedError } from '@atlas/shared';
import { FileLogger } from './adapters/file-logger.js';
import { resolveDataDir } from './data-dir.js';
import { createEngine } from './engine.js';

/**
 * Standalone Engine entry point. It boots the Engine without Electron,
 * applies migrations and reports its health.
 */
async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'status';
  if (command !== 'status' && command !== 'migrate') {
    process.stderr.write('Usage: atlas-engine [status|migrate]\n');
    return 2;
  }
  let engine;
  try {
    engine = createEngine({ component: 'engine' });
    const projects = await engine.projects.findAll();
    const report = {
      status: 'ok',
      dataDir: engine.dataDir,
      databasePath: engine.databasePath,
      schemaVersion: engine.schemaVersion(),
      projectCount: projects.length,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const logger =
      engine?.logger ??
      new FileLogger({
        filePath: path.join(
          resolveDataDir({ env: process.env, platform: process.platform, homeDir: os.homedir() }),
          'logs',
          'atlas.log',
        ),
        component: 'engine',
      });
    logger.error('Engine command failed', { command, error: describeError(error) });
    process.stderr.write(`Error: ${toSerializedError(error).message}\n`);
    return 1;
  } finally {
    engine?.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
