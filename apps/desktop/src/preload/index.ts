import {
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_SEND_CHANNELS,
  type AppCommand,
  type AtlasApi,
  type TerminalEventMessage,
} from '@atlas/contracts/ipc';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** Subscribes to a main-process event without exposing the IpcRendererEvent. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// Only typed, purpose-specific calls are exposed. The renderer never receives
// ipcRenderer, Node.js APIs, filesystem or database handles.
const api: AtlasApi = {
  projects: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.listProjects),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.getProject, id),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createProject, input),
    update: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.updateProject, id, input),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.removeProject, id),
    select: (id) => ipcRenderer.invoke(IPC_CHANNELS.selectProject, id),
    getSelected: () => ipcRenderer.invoke(IPC_CHANNELS.getSelectedProject),
  },
  dialog: {
    chooseDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory),
  },
  terminals: {
    list: (projectId) =>
      projectId === undefined
        ? ipcRenderer.invoke(IPC_CHANNELS.listTerminals)
        : ipcRenderer.invoke(IPC_CHANNELS.listTerminals, projectId),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTerminal, input),
    rename: (id, title) => ipcRenderer.invoke(IPC_CHANNELS.renameTerminal, id, title),
    terminate: (id) => ipcRenderer.invoke(IPC_CHANNELS.terminateTerminal, id),
    restart: (id) => ipcRenderer.invoke(IPC_CHANNELS.restartTerminal, id),
    dismiss: (id) => ipcRenderer.invoke(IPC_CHANNELS.dismissTerminal, id),
    closeInfo: (id) => ipcRenderer.invoke(IPC_CHANNELS.terminalCloseInfo, id),
    clear: (id) => ipcRenderer.invoke(IPC_CHANNELS.clearTerminal, id),
    attach: (id, viewId, columns, rows) =>
      ipcRenderer.invoke(IPC_CHANNELS.attachTerminal, id, viewId, columns, rows),
    detach: (id, viewId) => ipcRenderer.invoke(IPC_CHANNELS.detachTerminal, id, viewId),
    shells: () => ipcRenderer.invoke(IPC_CHANNELS.listShells),
    getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.getTerminalPreferences),
    setPreferences: (input) => ipcRenderer.invoke(IPC_CHANNELS.setTerminalPreferences, input),
    getLayout: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.getTerminalLayout, projectId),
    setLayout: (projectId, layout) =>
      ipcRenderer.invoke(IPC_CHANNELS.setTerminalLayout, projectId, layout),
    write: (id, data) => ipcRenderer.send(IPC_SEND_CHANNELS.writeTerminal, id, data),
    resize: (id, columns, rows) =>
      ipcRenderer.send(IPC_SEND_CHANNELS.resizeTerminal, id, columns, rows),
    acknowledge: (id, viewId, characters) =>
      ipcRenderer.send(IPC_SEND_CHANNELS.acknowledgeTerminal, id, viewId, characters),
    onEvent: (listener) =>
      subscribe<TerminalEventMessage>(IPC_EVENT_CHANNELS.terminalEvent, listener),
  },
  app: {
    onCommand: (listener) => subscribe<AppCommand>(IPC_EVENT_CHANNELS.appCommand, listener),
    onEngineRestarted: (listener) =>
      subscribe<undefined>(IPC_EVENT_CHANNELS.engineRestarted, () => listener()),
  },
};

contextBridge.exposeInMainWorld('atlas', api);
