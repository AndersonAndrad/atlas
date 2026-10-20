import { IPC_CHANNELS, type AtlasApi } from '@atlas/contracts/ipc';
import { contextBridge, ipcRenderer } from 'electron';

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
};

contextBridge.exposeInMainWorld('atlas', api);
