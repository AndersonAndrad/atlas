import type { SerializedError } from '@atlas/shared';
import type {
  CreateProjectInput,
  Project,
  ProjectDetails,
  ProjectPathInspection,
  UpdateProjectInput,
} from './project.js';
import type {
  CreateTerminalInput,
  ShellCatalog,
  TerminalAttachment,
  TerminalCloseInfo,
  TerminalEvent,
  TerminalPreferences,
  TerminalSession,
  UpdateTerminalPreferencesInput,
} from './terminal.js';
import type { TerminalWorkspaceLayout } from './terminal-layout.js';

export const IPC_CHANNELS = {
  listProjects: 'atlas:projects:list',
  getProject: 'atlas:projects:get',
  createProject: 'atlas:projects:create',
  updateProject: 'atlas:projects:update',
  removeProject: 'atlas:projects:remove',
  selectProject: 'atlas:projects:select',
  getSelectedProject: 'atlas:projects:get-selected',
  chooseDirectory: 'atlas:dialog:choose-directory',

  listTerminals: 'atlas:terminals:list',
  createTerminal: 'atlas:terminals:create',
  renameTerminal: 'atlas:terminals:rename',
  terminateTerminal: 'atlas:terminals:terminate',
  restartTerminal: 'atlas:terminals:restart',
  dismissTerminal: 'atlas:terminals:dismiss',
  terminalCloseInfo: 'atlas:terminals:close-info',
  clearTerminal: 'atlas:terminals:clear',
  attachTerminal: 'atlas:terminals:attach',
  detachTerminal: 'atlas:terminals:detach',
  listShells: 'atlas:terminals:shells',
  getTerminalPreferences: 'atlas:terminals:get-preferences',
  setTerminalPreferences: 'atlas:terminals:set-preferences',
  getTerminalLayout: 'atlas:terminals:get-layout',
  setTerminalLayout: 'atlas:terminals:set-layout',
} as const;

/** Fire-and-forget channels used for high-frequency terminal traffic. */
export const IPC_SEND_CHANNELS = {
  writeTerminal: 'atlas:terminals:write',
  resizeTerminal: 'atlas:terminals:resize',
  acknowledgeTerminal: 'atlas:terminals:ack',
} as const;

/** Channels the main process uses to push events to the renderer. */
export const IPC_EVENT_CHANNELS = {
  terminalEvent: 'atlas:terminals:event',
  appCommand: 'atlas:app:command',
  engineRestarted: 'atlas:engine:restarted',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

export interface DirectoryChoice {
  canceled: boolean;
  inspection?: ProjectPathInspection;
}

/** Commands triggered from the application menu and its keyboard shortcuts. */
export const APP_COMMANDS = [
  'view.projects',
  'view.terminals',
  'terminal.new',
  'terminal.close',
  'terminal.next',
  'terminal.previous',
  'terminal.splitRight',
  'terminal.splitDown',
  'terminal.focusNextPane',
  'terminal.focusPreviousPane',
  'terminal.search',
  'terminal.clear',
  'terminal.fontIncrease',
  'terminal.fontDecrease',
  'terminal.fontReset',
] as const;

export type AppCommand = (typeof APP_COMMANDS)[number];

export type Unsubscribe = () => void;

export interface TerminalEventMessage {
  event: TerminalEvent;
  viewId?: string;
}

/** Identifies one terminal view inside the renderer. */
export const TERMINAL_VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The only API exposed to the renderer through the preload bridge.
 * Paths can only originate from the native directory picker; the main process
 * rejects create/update requests for paths it did not hand out. Terminal
 * working directories are always derived from registered projects.
 */
export interface AtlasApi {
  projects: {
    list(): Promise<IpcResult<ProjectDetails[]>>;
    get(id: string): Promise<IpcResult<ProjectDetails>>;
    create(input: CreateProjectInput): Promise<IpcResult<Project>>;
    update(id: string, input: UpdateProjectInput): Promise<IpcResult<Project>>;
    remove(id: string): Promise<IpcResult<null>>;
    select(id: string): Promise<IpcResult<null>>;
    getSelected(): Promise<IpcResult<ProjectDetails | null>>;
  };
  dialog: {
    chooseDirectory(): Promise<IpcResult<DirectoryChoice>>;
  };
  terminals: {
    list(projectId?: string): Promise<IpcResult<TerminalSession[]>>;
    create(input: CreateTerminalInput): Promise<IpcResult<TerminalSession>>;
    rename(id: string, title: string): Promise<IpcResult<TerminalSession>>;
    terminate(id: string): Promise<IpcResult<TerminalSession>>;
    restart(id: string): Promise<IpcResult<TerminalSession>>;
    /** Terminates the process if needed and closes the tab. */
    dismiss(id: string): Promise<IpcResult<null>>;
    closeInfo(id: string): Promise<IpcResult<TerminalCloseInfo>>;
    clear(id: string): Promise<IpcResult<null>>;
    /** `viewId` identifies the terminal view (pane) that will receive the output. */
    attach(
      id: string,
      viewId: string,
      columns: number,
      rows: number,
    ): Promise<IpcResult<TerminalAttachment>>;
    detach(id: string, viewId: string): Promise<IpcResult<null>>;
    shells(): Promise<IpcResult<ShellCatalog>>;
    getPreferences(): Promise<IpcResult<TerminalPreferences>>;
    setPreferences(input: UpdateTerminalPreferencesInput): Promise<IpcResult<TerminalPreferences>>;
    getLayout(projectId: string): Promise<IpcResult<TerminalWorkspaceLayout | null>>;
    setLayout(projectId: string, layout: TerminalWorkspaceLayout): Promise<IpcResult<null>>;
    write(id: string, data: string): void;
    resize(id: string, columns: number, rows: number): void;
    /** Reports how many output characters the view has rendered (flow control). */
    acknowledge(id: string, viewId: string, characters: number): void;
    /** Output events carry the id of the view they are addressed to. */
    onEvent(listener: (message: TerminalEventMessage) => void): Unsubscribe;
  };
  app: {
    onCommand(listener: (command: AppCommand) => void): Unsubscribe;
    /** The Engine process restarted; terminal state must be reloaded. */
    onEngineRestarted(listener: () => void): Unsubscribe;
  };
}
