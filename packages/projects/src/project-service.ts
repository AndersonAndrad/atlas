import {
  CreateProjectInputSchema,
  ProjectIdSchema,
  UpdateProjectInputSchema,
  WorkspacePathSchema,
  parseInput,
  type CreateProjectInput,
  type Project,
  type ProjectAvailability,
  type ProjectDetails,
  type ProjectPathInspection,
  type UpdateProjectInput,
} from '@atlas/contracts';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';
import {
  isAbsoluteForPlatform,
  normalizeAbsolutePath,
  toPathKey,
  type PathPlatform,
} from './path-normalization.js';
import type {
  Clock,
  IdGenerator,
  PathInspector,
  ProjectRepository,
  SettingsRepository,
} from './ports.js';

export const SELECTED_PROJECT_SETTING = 'projects.selectedProjectId';

export interface ProjectServiceDependencies {
  projects: ProjectRepository;
  settings: SettingsRepository;
  inspector: PathInspector;
  clock: Clock;
  generateId: IdGenerator;
  platform: PathPlatform;
  logger?: Logger;
}

export class ProjectService {
  private readonly logger: Logger;

  constructor(private readonly deps: ProjectServiceDependencies) {
    this.logger = deps.logger ?? noopLogger;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const parsed = parseInput(CreateProjectInputSchema, input);
    const inspection = await this.inspectAvailableDirectory(parsed.workspacePath);
    const workspacePath = inspection.resolvedPath!;
    const pathKey = toPathKey(workspacePath, this.deps.platform);

    await this.assertPathNotRegistered(pathKey);

    const now = this.deps.clock.now().toISOString();
    const project: Project = {
      id: this.deps.generateId(),
      name: parsed.name,
      ...(parsed.description ? { description: parsed.description } : {}),
      tags: parsed.tags,
      workspacePath,
      git: storedGit(inspection),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.projects.insert({ project, pathKey });
    this.logger.info('Project registered', { projectId: project.id });
    return project;
  }

  findAll(): Promise<Project[]> {
    return this.deps.projects.findAll();
  }

  async findById(id: string): Promise<Project | null> {
    const parsedId = ProjectIdSchema.safeParse(id);
    if (!parsedId.success) return null;
    return this.deps.projects.findById(parsedId.data);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const existing = await this.getExisting(id);
    const parsed = parseInput(UpdateProjectInputSchema, input);

    const updated: Project = { ...existing, git: { ...existing.git }, tags: [...existing.tags] };
    if (parsed.name !== undefined) updated.name = parsed.name;
    if (parsed.tags !== undefined) updated.tags = parsed.tags;
    if (parsed.description !== undefined) {
      if (parsed.description === null || parsed.description === '') {
        delete updated.description;
      } else {
        updated.description = parsed.description;
      }
    }

    let pathKey = toPathKey(existing.workspacePath, this.deps.platform);
    if (parsed.workspacePath !== undefined) {
      const inspection = await this.inspectAvailableDirectory(parsed.workspacePath);
      updated.workspacePath = inspection.resolvedPath!;
      updated.git = storedGit(inspection);
      pathKey = toPathKey(updated.workspacePath, this.deps.platform);
      await this.assertPathNotRegistered(pathKey, existing.id);
    }

    updated.updatedAt = this.deps.clock.now().toISOString();
    await this.deps.projects.update({ project: updated, pathKey });
    this.logger.info('Project updated', { projectId: updated.id });
    return updated;
  }

  /** Removes the registry entry only. The project directory is never touched. */
  async remove(id: string): Promise<void> {
    const existing = await this.getExisting(id);
    const deleted = await this.deps.projects.delete(existing.id);
    if (!deleted) {
      throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId: id } });
    }
    const selectedId = await this.deps.settings.get(SELECTED_PROJECT_SETTING);
    if (selectedId === existing.id) {
      await this.deps.settings.delete(SELECTED_PROJECT_SETTING);
    }
    this.logger.info('Project removed from registry', { projectId: existing.id });
  }

  /** Inspects a directory without registering it. Never throws for unavailable directories. */
  async inspectPath(inputPath: string): Promise<ProjectPathInspection> {
    const absolutePath = this.parseAbsolutePath(inputPath);
    return this.deps.inspector.inspect(absolutePath);
  }

  /** Marks a project as the selected one and records when it was opened. */
  async selectProject(id: string): Promise<void> {
    const existing = await this.getExisting(id);
    const inspection = await this.deps.inspector.inspect(existing.workspacePath);
    const now = this.deps.clock.now().toISOString();
    const updated: Project = { ...existing, lastOpenedAt: now };
    // Refresh stable Git metadata opportunistically while the directory is reachable.
    if (inspection.availability.status === 'available') {
      updated.git = storedGit(inspection);
    }
    await this.deps.projects.update({
      project: updated,
      pathKey: toPathKey(existing.workspacePath, this.deps.platform),
    });
    await this.deps.settings.set(SELECTED_PROJECT_SETTING, existing.id);
  }

  /**
   * Returns the previously selected project while it is still registered.
   * A project whose directory became unavailable is still returned so the
   * user can see its status and update the path (FR-009).
   */
  async getSelectedProject(): Promise<Project | null> {
    const selectedId = await this.deps.settings.get(SELECTED_PROJECT_SETTING);
    if (selectedId === null) return null;
    const project = await this.findById(selectedId);
    if (project === null) {
      this.logger.warn('Selected project no longer registered; clearing selection', {
        projectId: selectedId,
      });
      await this.deps.settings.delete(SELECTED_PROJECT_SETTING);
    }
    return project;
  }

  /**
   * Returns the canonical path of a registered project's directory after
   * checking that it is currently available. Used to authorize terminal
   * working directories: only registered workspaces are ever returned.
   */
  async resolveAvailableWorkspace(id: string): Promise<string> {
    const project = await this.getExisting(id);
    const inspection = await this.deps.inspector.inspect(project.workspacePath);
    assertAvailable(inspection.availability, project.workspacePath);
    if (inspection.resolvedPath === undefined) {
      throw new AtlasError('PROJECT_PATH_UNAVAILABLE', undefined, { details: { projectId: id } });
    }
    return inspection.resolvedPath;
  }

  /**
   * Validates any absolute directory (not necessarily registered) and returns its
   * realpath. Used for standalone terminals.
   */
  async resolveAvailableDirectory(inputPath: string): Promise<string> {
    const inspection = await this.inspectAvailableDirectory(inputPath);
    return inspection.resolvedPath!;
  }

  /** Returns the registered project whose directory contains `directory`, if any. */
  async findContaining(directory: string): Promise<Project | null> {
    if (!isAbsoluteForPlatform(directory, this.deps.platform)) return null;
    const key = toPathKey(normalizeAbsolutePath(directory, this.deps.platform), this.deps.platform);
    const separator = this.deps.platform === 'win32' ? '\\' : '/';
    let best: Project | null = null;
    let bestLength = -1;
    for (const project of await this.deps.projects.findAll()) {
      const projectKey = toPathKey(project.workspacePath, this.deps.platform);
      const prefix = projectKey.endsWith(separator) ? projectKey : projectKey + separator;
      const contains = key === projectKey || key.startsWith(prefix);
      // The deepest registered directory wins (nested projects).
      if (contains && projectKey.length > bestLength) {
        best = project;
        bestLength = projectKey.length;
      }
    }
    return best;
  }

  async getDetails(id: string): Promise<ProjectDetails> {
    const project = await this.getExisting(id);
    const selectedId = await this.deps.settings.get(SELECTED_PROJECT_SETTING);
    return this.toDetails(project, selectedId);
  }

  async listDetails(): Promise<ProjectDetails[]> {
    const [projects, selectedId] = await Promise.all([
      this.deps.projects.findAll(),
      this.deps.settings.get(SELECTED_PROJECT_SETTING),
    ]);
    return Promise.all(projects.map((project) => this.toDetails(project, selectedId)));
  }

  private async toDetails(project: Project, selectedId: string | null): Promise<ProjectDetails> {
    const inspection = await this.deps.inspector.inspect(project.workspacePath);
    return {
      project,
      availability: inspection.availability,
      git: inspection.git,
      isSelected: project.id === selectedId,
    };
  }

  private async getExisting(id: string): Promise<Project> {
    const project = await this.findById(id);
    if (project === null) {
      throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId: id } });
    }
    return project;
  }

  private parseAbsolutePath(inputPath: string): string {
    const value = parseInput(WorkspacePathSchema, inputPath);
    if (!isAbsoluteForPlatform(value, this.deps.platform)) {
      throw new AtlasError('PROJECT_PATH_INVALID', 'Project paths must be absolute.', {
        details: { inputPath },
      });
    }
    return normalizeAbsolutePath(value, this.deps.platform);
  }

  private async inspectAvailableDirectory(inputPath: string): Promise<ProjectPathInspection> {
    const inspection = await this.inspectPath(inputPath);
    assertAvailable(inspection.availability, inputPath);
    if (inspection.resolvedPath === undefined) {
      throw new AtlasError('PROJECT_PATH_UNAVAILABLE', undefined, { details: { inputPath } });
    }
    return inspection;
  }

  private async assertPathNotRegistered(pathKey: string, exceptProjectId?: string): Promise<void> {
    const owner = await this.deps.projects.findByPathKey(pathKey);
    if (owner !== null && owner.id !== exceptProjectId) {
      throw new AtlasError('PROJECT_ALREADY_EXISTS', undefined, {
        details: { existingProjectId: owner.id },
      });
    }
  }
}

function assertAvailable(availability: ProjectAvailability, inputPath: string): void {
  const details = { inputPath, status: availability.status };
  switch (availability.status) {
    case 'available':
      return;
    case 'missing':
      throw new AtlasError('PROJECT_PATH_UNAVAILABLE', undefined, { details });
    case 'not-a-directory':
      throw new AtlasError('PROJECT_PATH_INVALID', undefined, { details });
    case 'permission-denied':
      throw new AtlasError('PROJECT_PERMISSION_DENIED', undefined, { details });
  }
}

function storedGit(inspection: ProjectPathInspection): Project['git'] {
  return inspection.git.isRepository && inspection.git.repositoryRoot !== undefined
    ? { isRepository: true, repositoryRoot: inspection.git.repositoryRoot }
    : { isRepository: false };
}
