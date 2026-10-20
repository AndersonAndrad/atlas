import type { AppCommand } from '@atlas/contracts/ipc';
import type { MenuItemConstructorOptions } from 'electron';

export interface ShortcutDefinition {
  command: AppCommand;
  label: string;
  /** Accelerator on macOS. */
  mac: string;
  /** Accelerator on Windows and Linux; avoids Ctrl+<letter>, which shells use. */
  other: string;
}

/**
 * Terminal shortcuts. On Windows/Linux they use Ctrl+Shift so that Ctrl+C,
 * Ctrl+D, Ctrl+W, etc. still reach the shell. Documented in docs/sdd/SDD-002.
 */
export const TERMINAL_SHORTCUTS: readonly ShortcutDefinition[] = [
  { command: 'terminal.new', label: 'New Terminal', mac: 'Cmd+T', other: 'Ctrl+Shift+T' },
  { command: 'terminal.close', label: 'Close Terminal', mac: 'Cmd+W', other: 'Ctrl+Shift+W' },
  { command: 'terminal.next', label: 'Next Terminal', mac: 'Cmd+Shift+]', other: 'Ctrl+PageDown' },
  {
    command: 'terminal.previous',
    label: 'Previous Terminal',
    mac: 'Cmd+Shift+[',
    other: 'Ctrl+PageUp',
  },
  { command: 'terminal.splitRight', label: 'Split Right', mac: 'Cmd+D', other: 'Ctrl+Shift+D' },
  { command: 'terminal.splitDown', label: 'Split Down', mac: 'Cmd+Shift+D', other: 'Ctrl+Shift+E' },
  {
    command: 'terminal.focusNextPane',
    label: 'Focus Next Pane',
    mac: 'Cmd+]',
    other: 'Ctrl+Shift+]',
  },
  {
    command: 'terminal.focusPreviousPane',
    label: 'Focus Previous Pane',
    mac: 'Cmd+[',
    other: 'Ctrl+Shift+[',
  },
  { command: 'terminal.search', label: 'Find…', mac: 'Cmd+F', other: 'Ctrl+Shift+F' },
  { command: 'terminal.clear', label: 'Clear Terminal', mac: 'Cmd+K', other: 'Ctrl+Shift+K' },
  { command: 'terminal.fontIncrease', label: 'Increase Font Size', mac: 'Cmd+=', other: 'Ctrl+=' },
  { command: 'terminal.fontDecrease', label: 'Decrease Font Size', mac: 'Cmd+-', other: 'Ctrl+-' },
  { command: 'terminal.fontReset', label: 'Reset Font Size', mac: 'Cmd+0', other: 'Ctrl+0' },
];

const VIEW_SHORTCUTS: readonly ShortcutDefinition[] = [
  { command: 'view.projects', label: 'Projects', mac: 'Cmd+1', other: 'Ctrl+Shift+1' },
  { command: 'view.terminals', label: 'Terminals', mac: 'Cmd+2', other: 'Ctrl+Shift+2' },
  { command: 'view.sessions', label: 'Sessions', mac: 'Cmd+3', other: 'Ctrl+Shift+3' },
];

export interface MenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  isDevelopment: boolean;
  sendCommand: (command: AppCommand) => void;
}

/** Builds the application menu, which also carries every keyboard shortcut. */
export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const isMac = options.platform === 'darwin';
  const item = (shortcut: ShortcutDefinition): MenuItemConstructorOptions => ({
    id: shortcut.command,
    label: shortcut.label,
    accelerator: isMac ? shortcut.mac : shortcut.other,
    click: () => options.sendCommand(shortcut.command),
  });
  const find = (command: AppCommand) => {
    const shortcut = TERMINAL_SHORTCUTS.find((entry) => entry.command === command);
    if (shortcut === undefined) throw new Error(`Unknown shortcut ${command}`);
    return item(shortcut);
  };

  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: options.appName,
      submenu: [
        {
          id: 'app.about',
          label: `About ${options.appName}`,
          click: () => options.sendCommand('app.about'),
        },
        { type: 'separator' },
        {
          id: 'app.settings',
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => options.sendCommand('app.settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push(
    {
      label: 'File',
      submenu: [
        find('terminal.new'),
        find('terminal.close'),
        { type: 'separator' },
        isMac
          ? { label: 'Close Window', role: 'close', accelerator: 'Cmd+Shift+W' }
          : { role: 'quit', accelerator: 'Ctrl+Q' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut', ...(isMac ? {} : { accelerator: 'Ctrl+Shift+X' }) },
        // Ctrl+C must stay an interrupt in terminals on Windows and Linux.
        { role: 'copy', ...(isMac ? {} : { accelerator: 'Ctrl+Shift+C' }) },
        { role: 'paste', ...(isMac ? {} : { accelerator: 'Ctrl+Shift+V' }) },
        { role: 'selectAll', ...(isMac ? {} : { accelerator: 'Ctrl+Shift+A' }) },
        { type: 'separator' },
        find('terminal.search'),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...VIEW_SHORTCUTS.map(item),
        { type: 'separator' },
        find('terminal.fontIncrease'),
        find('terminal.fontDecrease'),
        find('terminal.fontReset'),
        ...(options.isDevelopment
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        find('terminal.next'),
        find('terminal.previous'),
        { type: 'separator' },
        find('terminal.splitRight'),
        find('terminal.splitDown'),
        find('terminal.focusNextPane'),
        find('terminal.focusPreviousPane'),
        { type: 'separator' },
        find('terminal.clear'),
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }],
    },
  );
  if (!isMac) {
    template.push({
      label: 'Help',
      submenu: [
        {
          id: 'app.settings',
          label: 'Settings',
          accelerator: 'Ctrl+,',
          click: () => options.sendCommand('app.settings'),
        },
        {
          id: 'app.about',
          label: `About ${options.appName}`,
          click: () => options.sendCommand('app.about'),
        },
      ],
    });
  }
  return template;
}
