import type { SerializedError } from '@atlas/shared';
import type {
  CreateProjectInput,
  Project,
  ProjectDetails,
  ProjectPathInspection,
  UpdateProjectInput,
} from './project.js';

export const IPC_CHANNELS = {
  listProjects: 'atlas:projects:list',
  getProject: 'atlas:projects:get',
  createProject: 'atlas:projects:create',
  updateProject: 'atlas:projects:update',
  removeProject: 'atlas:projects:remove',
  selectProject: 'atlas:projects:select',
  getSelectedProject: 'atlas:projects:get-selected',
  chooseDirectory: 'atlas:dialog:choose-directory',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

export interface DirectoryChoice {
  canceled: boolean;
  inspection?: ProjectPathInspection;
}

/**
 * The only API exposed to the renderer through the preload bridge.
 * Paths can only originate from the native directory picker; the main process
 * rejects create/update requests for paths it did not hand out.
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
}
