import type { TerminalEvent, TerminalFontFamily, TerminalPreferences } from '@atlas/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal, type ITheme } from '@xterm/xterm';
import { unwrap } from '@/api';
import { splitInput } from './input';
import { onViewOutput } from './terminal-events';

type OutputEvent = Extract<TerminalEvent, { type: 'output' }>;

export const FONT_FAMILIES: Record<TerminalFontFamily, { label: string; css: string }> = {
  system: {
    label: 'System monospace',
    css: '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
  'sf-mono': { label: 'SF Mono', css: '"SF Mono", monospace' },
  menlo: { label: 'Menlo', css: 'Menlo, monospace' },
  monaco: { label: 'Monaco', css: 'Monaco, monospace' },
  courier: { label: 'Courier', css: '"Courier New", Courier, monospace' },
};

const THEME: ITheme = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3b82f680',
  black: '#262626',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d4',
  brightBlack: '#737373',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const RESIZE_DEBOUNCE_MS = 60;

let viewCounter = 0;

export interface TerminalViewOptions {
  sessionId: string;
  container: HTMLElement;
  preferences: TerminalPreferences;
  /** Whether keyboard input should be forwarded (false once the process ended). */
  acceptsInput: boolean;
  onError: (message: string) => void;
}

/**
 * One xterm.js view of an Engine terminal session. Output is written straight
 * into xterm (never through React state) and acknowledged for flow control.
 * Disposing the view only detaches it; the process keeps running.
 */
export class TerminalView {
  readonly viewId = `v${Date.now().toString(36)}${(viewCounter++).toString(36)}`;
  private readonly terminal: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly cleanups: (() => void)[] = [];
  private attached = false;
  private disposed = false;
  private pending: OutputEvent[] = [];
  private lastSeq = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private acceptsInput: boolean;

  constructor(private readonly options: TerminalViewOptions) {
    this.acceptsInput = options.acceptsInput;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: options.preferences.fontSize,
      fontFamily: FONT_FAMILIES[options.preferences.fontFamily].css,
      scrollback: options.preferences.scrollback,
      theme: THEME,
      macOptionIsMeta: false,
      allowTransparency: false,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
  }

  /** Opens the view and attaches it to the session, replaying the current screen. */
  async start(): Promise<void> {
    const { container, sessionId } = this.options;
    this.terminal.open(container);
    this.safeFit();
    this.cleanups.push(onViewOutput(this.viewId, (event) => this.handleOutput(event)));

    const input = this.terminal.onData((data) => {
      if (!this.acceptsInput) return;
      // Large pastes arrive as one chunk; split them below the IPC message limit.
      for (const chunk of splitInput(data)) window.atlas.terminals.write(sessionId, chunk);
    });
    this.cleanups.push(() => input.dispose());

    const observer = new ResizeObserver(() => this.scheduleResize());
    observer.observe(container);
    this.cleanups.push(() => observer.disconnect());

    try {
      const attachment = await unwrap(
        window.atlas.terminals.attach(
          sessionId,
          this.viewId,
          this.terminal.cols,
          this.terminal.rows,
        ),
      );
      if (this.disposed) return;
      this.lastSeq = attachment.seq;
      if (attachment.snapshot !== '') this.terminal.write(attachment.snapshot);
      this.attached = true;
      const buffered = this.pending;
      this.pending = [];
      for (const event of buffered) this.handleOutput(event);
    } catch (error) {
      if (!this.disposed) {
        this.options.onError(error instanceof Error ? error.message : 'Could not attach.');
      }
    }
  }

  setAcceptsInput(acceptsInput: boolean): void {
    this.acceptsInput = acceptsInput;
  }

  setPreferences(preferences: TerminalPreferences): void {
    this.terminal.options.fontSize = preferences.fontSize;
    this.terminal.options.fontFamily = FONT_FAMILIES[preferences.fontFamily].css;
    this.terminal.options.scrollback = preferences.scrollback;
    this.scheduleResize();
  }

  focus(): void {
    this.terminal.focus();
  }

  /** Clears the screen and scrollback here and in the Engine mirror. */
  clear(): void {
    this.terminal.clear();
    void window.atlas.terminals.clear(this.options.sessionId);
  }

  findNext(term: string): boolean {
    return term !== '' && this.search.findNext(term, { incremental: true });
  }

  findPrevious(term: string): boolean {
    return term !== '' && this.search.findPrevious(term);
  }

  clearSearch(): void {
    this.search.clearDecorations();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    void window.atlas.terminals.detach(this.options.sessionId, this.viewId);
    this.terminal.dispose();
  }

  private handleOutput(event: OutputEvent): void {
    if (!this.attached) {
      this.pending.push(event);
      return;
    }
    // Events up to the snapshot's sequence number are already on screen.
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const length = event.data.length;
    this.terminal.write(event.data, () => {
      if (!this.disposed) {
        window.atlas.terminals.acknowledge(this.options.sessionId, this.viewId, length);
      }
    });
  }

  private scheduleResize(): void {
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      const before = { cols: this.terminal.cols, rows: this.terminal.rows };
      this.safeFit();
      const { cols, rows } = this.terminal;
      if (this.attached && (cols !== before.cols || rows !== before.rows)) {
        window.atlas.terminals.resize(this.options.sessionId, cols, rows);
      }
    }, RESIZE_DEBOUNCE_MS);
  }

  private safeFit(): void {
    if (this.disposed) return;
    // A hidden or zero-sized container cannot be measured; keep the last size.
    if (this.fit.proposeDimensions() === undefined) return;
    try {
      this.fit.fit();
    } catch {
      // Measuring can fail while the element is being detached.
    }
  }
}
