import { createRequire } from 'node:module';
import type { ScreenMirror, ScreenMirrorFactory } from '@atlas/terminal';
import type * as XtermHeadless from '@xterm/headless';
import type * as XtermSerialize from '@xterm/addon-serialize';

const require = createRequire(import.meta.url);

/** Scrollback kept by the mirror, and therefore the maximum replay on reattach. */
export const MIRROR_SCROLLBACK_LINES = 1000;

/**
 * ScreenMirror backed by a headless xterm.js instance. Serializing it restores
 * colors, cursor position and the alternate screen used by full-screen programs.
 */
export class HeadlessScreenMirrorFactory implements ScreenMirrorFactory {
  create(columns: number, rows: number): ScreenMirror {
    const { Terminal } = require('@xterm/headless') as typeof XtermHeadless;
    const { SerializeAddon } = require('@xterm/addon-serialize') as typeof XtermSerialize;
    const terminal = new Terminal({
      cols: columns,
      rows,
      scrollback: MIRROR_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    return new HeadlessScreenMirror(terminal, serializer);
  }
}

class HeadlessScreenMirror implements ScreenMirror {
  constructor(
    private readonly terminal: XtermHeadless.Terminal,
    private readonly serializer: XtermSerialize.SerializeAddon,
  ) {}

  write(data: string, callback?: () => void): void {
    this.terminal.write(data, callback);
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(columns, rows);
  }

  clear(): void {
    this.terminal.clear();
  }

  serialize(): string {
    return this.serializer.serialize({ scrollback: MIRROR_SCROLLBACK_LINES });
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
