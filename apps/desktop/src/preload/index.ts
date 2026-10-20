import {
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_SEND_CHANNELS,
  type AppCommand,
  type AtlasApi,
  type SessionChangedEvent,
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
    chooseDirectory: (purpose) =>
      purpose === undefined
        ? ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory)
        : ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory, purpose),
  },
  terminals: {
    list: (projectId) =>
      projectId === undefined
        ? ipcRenderer.invoke(IPC_CHANNELS.listTerminals)
        : ipcRenderer.invoke(IPC_CHANNELS.listTerminals, projectId),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTerminal, input),
    rename: (id, title) => ipcRenderer.invoke(IPC_CHANNELS.renameTerminal, id, title),
    associate: (id, projectId) => ipcRenderer.invoke(IPC_CHANNELS.associateTerminal, id, projectId),
    move: (id, groupId, position) =>
      ipcRenderer.invoke(IPC_CHANNELS.moveTerminal, id, groupId, position),
    projectContext: (id) => ipcRenderer.invoke(IPC_CHANNELS.terminalProjectContext, id),
    git: (id) => ipcRenderer.invoke(IPC_CHANNELS.terminalGit, id),
    registerProject: (id, input) =>
      ipcRenderer.invoke(IPC_CHANNELS.registerTerminalProject, id, input),
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
  groups: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.listGroups),
    create: (name) => ipcRenderer.invoke(IPC_CHANNELS.createGroup, name),
    rename: (id, name) => ipcRenderer.invoke(IPC_CHANNELS.renameGroup, id, name),
    setCollapsed: (id, collapsed) =>
      ipcRenderer.invoke(IPC_CHANNELS.setGroupCollapsed, id, collapsed),
    move: (id, position) => ipcRenderer.invoke(IPC_CHANNELS.moveGroup, id, position),
    delete: (id, options) => ipcRenderer.invoke(IPC_CHANNELS.deleteGroup, id, options),
  },
  git: {
    project: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectGit, projectId),
    repositories: () => ipcRenderer.invoke(IPC_CHANNELS.gitRepositories),
    workingTree: (root) => ipcRenderer.invoke(IPC_CHANNELS.gitWorkingTree, root),
    diff: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitDiff, input),
    stage: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitStage, input),
    unstage: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitUnstage, input),
    commit: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitCommit, input),
    push: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitPush, input),
    pull: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitPull, input),
    pullInfo: (root) => ipcRenderer.invoke(IPC_CHANNELS.gitPullInfo, root),
    fetch: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitFetch, input),
    branches: (root) => ipcRenderer.invoke(IPC_CHANNELS.gitBranches, root),
    remotes: (root) => ipcRenderer.invoke(IPC_CHANNELS.gitRemotes, root),
    createBranch: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitCreateBranch, input),
    switchBranch: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitSwitchBranch, input),
    renameBranch: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitRenameBranch, input),
    suggestMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitSuggestMessage, input),
    operations: () => ipcRenderer.invoke(IPC_CHANNELS.gitOperations),
    cancelOperation: (id) => ipcRenderer.invoke(IPC_CHANNELS.gitCancelOperation, id),
    getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.gitGetPreferences),
    setPreferences: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitSetPreferences, input),
    commitContext: (root) => ipcRenderer.invoke(IPC_CHANNELS.gitCommitContext, root),
    mergePreview: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitMergePreview, input),
    merge: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitMerge, input),
    abortMerge: (root) => ipcRenderer.invoke(IPC_CHANNELS.gitAbortMerge, root),
    getProjectSettings: (projectId) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitGetProjectSettings, projectId),
    setProjectSettings: (projectId, settings) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitSetProjectSettings, projectId, settings),
  },
  sessions: {
    list: (filter) =>
      filter === undefined
        ? ipcRenderer.invoke(IPC_CHANNELS.listSessions)
        : ipcRenderer.invoke(IPC_CHANNELS.listSessions, filter),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.getSession, id),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createSession, input),
    update: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.updateSession, id, input),
    perform: (id, action) => ipcRenderer.invoke(IPC_CHANNELS.performSessionAction, id, action),
    events: (id) => ipcRenderer.invoke(IPC_CHANNELS.sessionEvents, id),
    addTask: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.addSessionTask, id, input),
    updateTask: (id, taskId, input) =>
      ipcRenderer.invoke(IPC_CHANNELS.updateSessionTask, id, taskId, input),
    removeTask: (id, taskId) => ipcRenderer.invoke(IPC_CHANNELS.removeSessionTask, id, taskId),
    cancelTask: (id, taskId) => ipcRenderer.invoke(IPC_CHANNELS.cancelSessionTask, id, taskId),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSessionSettings),
    setSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionSettings, input),
    onChanged: (listener) =>
      subscribe<SessionChangedEvent>(IPC_EVENT_CHANNELS.sessionChanged, listener),
  },
  context: {
    overview: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextOverview, ...args),
    list: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextList, ...args),
    global: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextGlobal, ...args),
    record: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextRecord, ...args),
    update: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextUpdate, ...args),
    remove: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextRemove, ...args),
    history: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextHistory, ...args),
    tasks: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextTasks, ...args),
    createTask: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextCreateTask, ...args),
    updateTask: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextUpdateTask, ...args),
    deleteTask: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextDeleteTask, ...args),
    decisions: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextDecisions, ...args),
    createDecision: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextCreateDecision, ...args),
    setDecisionStatus: (...args) =>
      ipcRenderer.invoke(IPC_CHANNELS.contextSetDecisionStatus, ...args),
    bundle: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextBundle, ...args),
    snapshot: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextSnapshot, ...args),
    prepareHandoff: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextPrepareHandoff, ...args),
    createHandoff: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextCreateHandoff, ...args),
    handoffs: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextHandoffs, ...args),
    handoff: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextHandoff, ...args),
    sessions: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextSessions, ...args),
    sessionEvidence: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextSessionEvidence, ...args),
    endSession: (...args) => ipcRenderer.invoke(IPC_CHANNELS.contextEndSession, ...args),
    sessionForTerminal: (...args) =>
      ipcRenderer.invoke(IPC_CHANNELS.contextSessionForTerminal, ...args),
  },
  ai: {
    start: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiStart, input),
    attach: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiAttach, input),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
    copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
    onCommand: (listener) => subscribe<AppCommand>(IPC_EVENT_CHANNELS.appCommand, listener),
    onEngineRestarted: (listener) =>
      subscribe<undefined>(IPC_EVENT_CHANNELS.engineRestarted, () => listener()),
  },
};

contextBridge.exposeInMainWorld('atlas', api);
