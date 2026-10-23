import type {
  ClipboardTarget,
  TerminalEvent,
  TerminalFontFamily,
  TerminalPreferences,
} from '@atlas/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal, type ITheme } from '@xterm/xterm';
import { unwrap } from '@/api';
import { clipboardShortcut, droppedPathsInput, splitInput } from './input';
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
/** Selection changes while dragging; the primary selection is written once it settles. */
const PRIMARY_SELECTION_DEBOUNCE_MS = 150;
const MIDDLE_BUTTON = 1;

const IS_MAC = navigator.userAgent.includes('Mac');
/** Only Linux has a primary selection (select to copy, middle-click to paste). */
const HAS_PRIMARY_SELECTION = navigator.userAgent.includes('Linux');

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
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
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
      // Programs that capture the mouse (TUIs, AI CLIs) block plain drag
      // selection; Option+drag (Shift+drag elsewhere) still selects text.
      macOptionClickForcesSelection: true,
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
    this.setUpClipboard(container);

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

  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  /** Copies the selected text to the clipboard; false when nothing is selected. */
  copySelection(): boolean {
    const text = this.terminal.getSelection();
    if (text === '') return false;
    void window.atlas.app.copyText(text);
    return true;
  }

  /** Pastes clipboard text as typed input (bracketed when the program asks for it). */
  async paste(target: ClipboardTarget = 'clipboard'): Promise<void> {
    if (!this.acceptsInput) return;
    const result = await window.atlas.app.readText(target);
    if (!result.ok || result.data === '' || this.disposed || !this.acceptsInput) return;
    this.terminal.paste(result.data);
  }

  selectAll(): void {
    this.terminal.selectAll();
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
    if (this.selectionTimer !== undefined) clearTimeout(this.selectionTimer);
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

  /**
   * Copy and paste shortcuts, dropped files and the Linux primary selection.
   * On macOS, Cmd+C/Cmd+V reach xterm through the Edit menu. Elsewhere xterm
   * consumes Ctrl+Shift+C/V before the menu sees them, so they are handled here;
   * Ctrl+C and Ctrl+V still reach the program (interrupt, image paste in CLIs).
   */
  private setUpClipboard(container: HTMLElement): void {
    if (!IS_MAC) {
      this.terminal.attachCustomKeyEventHandler((event) => this.handleClipboardKey(event));
    }

    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = this.acceptsInput ? 'copy' : 'none';
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (files === undefined || files.length === 0) return;
      // Without this, Chromium tries to open the file in the window.
      event.preventDefault();
      if (!this.acceptsInput) return;
      const text = droppedPathsInput(Array.from(files, (file) => window.atlas.files.pathFor(file)));
      if (text === '') return;
      this.terminal.paste(text);
      this.terminal.focus();
    };
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);
    this.cleanups.push(() => {
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
    });

    if (!HAS_PRIMARY_SELECTION) return;
    const selection = this.terminal.onSelectionChange(() => {
      if (this.selectionTimer !== undefined) clearTimeout(this.selectionTimer);
      this.selectionTimer = setTimeout(() => {
        this.selectionTimer = undefined;
        const text = this.terminal.getSelection();
        if (text !== '') void window.atlas.app.copyText(text, 'selection');
      }, PRIMARY_SELECTION_DEBOUNCE_MS);
    });
    this.cleanups.push(() => selection.dispose());
    // Programs with mouse reporting (vim, htop…) receive the middle click instead.
    const ownsMiddleClick = (event: MouseEvent) =>
      event.button === MIDDLE_BUTTON && this.terminal.modes.mouseTrackingMode === 'none';
    // Canceling both events stops Chromium's own paste, so text is pasted once.
    const onMiddleDown = (event: MouseEvent) => {
      if (ownsMiddleClick(event)) event.preventDefault();
    };
    const onMiddleUp = (event: MouseEvent) => {
      if (!ownsMiddleClick(event)) return;
      event.preventDefault();
      this.terminal.focus();
      void this.paste('selection');
    };
    container.addEventListener('mousedown', onMiddleDown, true);
    container.addEventListener('mouseup', onMiddleUp, true);
    this.cleanups.push(() => {
      container.removeEventListener('mousedown', onMiddleDown, true);
      container.removeEventListener('mouseup', onMiddleUp, true);
    });
  }

  /** Returns false (and cancels the event) for the shortcuts handled here. */
  private handleClipboardKey(event: KeyboardEvent): boolean {
    const action = clipboardShortcut(event);
    if (action === null) return true;
    event.preventDefault();
    if (event.type !== 'keydown') return false;
    if (action === 'copy') this.copySelection();
    else if (action === 'paste') void this.paste();
    else this.selectAll();
    return false;
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
