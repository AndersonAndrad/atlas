import path from 'node:path';
import type {
  AddSkillSourceInput,
  CreateSkillFromTemplateInput,
  DiscoveredSkill,
  EditSkillInput,
  ImportSkillCollectionInput,
  ImportSkillInput,
  RemoveSkillAssignmentInput,
  ResolvedSkill,
  Skill,
  SkillAssignmentInput,
  SkillCollectionPreview,
  SkillCollectionResult,
  SkillDetails,
  SkillDiff,
  SkillFileContent,
  SkillImportPreview,
  SkillSource,
  SkillSourceKind,
  SkillSourceSuggestion,
  SkillTemplate,
} from '@atlas/contracts';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';
import { analyzeSkill, type SkillAnalysis } from './analyze.js';
import { diffFiles, diffLines } from './diff.js';
import type {
  SkillFileSystem,
  SkillRepository,
  StoredSkillVersion,
  SuggestionEnvironment,
} from './ports.js';
import { resolveSkill, type ResolutionContext } from './resolve.js';
import { listTemplates, templateSkillFile } from './templates.js';

export interface SkillsServiceOptions {
  repository: SkillRepository;
  fs: SkillFileSystem;
  /** `<data>/skills`: ATLAS-managed copies, one folder per skill and version. */
  storageRoot: string;
  suggestions: SuggestionEnvironment;
  clock: { now(): Date };
  generateId: () => string;
  logger?: Logger;
}

/** Text files shown in the file viewer are cut at this size. */
const VIEW_LIMIT = 256 * 1024;

const notFound = () => new AtlasError('SKILL_NOT_FOUND');
const unauthorized = () => new AtlasError('SKILL_SOURCE_UNAUTHORIZED');
const invalid = (field: string, message: string) =>
  new AtlasError('VALIDATION_FAILED', message, { issues: [{ field, message }] });

const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}${path.sep}`);

/**
 * Skills Hub (SDD-006 Milestone B): a registry of reusable skills, independent of
 * provider sessions. Imported skills are copied into the ATLAS data directory as
 * immutable versions; their source folders are never changed or deleted. Skill
 * content is untrusted: ATLAS validates and shows it, and never executes it.
 */
export class SkillsService {
  protected readonly repo: SkillRepository;
  protected readonly fs: SkillFileSystem;
  protected readonly logger: Logger;

  constructor(protected readonly options: SkillsServiceOptions) {
    this.repo = options.repository;
    this.fs = options.fs;
    this.logger = options.logger ?? noopLogger;
  }

  protected now(): string {
    return this.options.clock.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // Sources and discovery (FR-616)
  // -------------------------------------------------------------------------

  /** Provider folders worth adding; nothing is read until the user adds one. */
  async suggestions(): Promise<SkillSourceSuggestion[]> {
    const { home, claudeConfigDir } = this.options.suggestions;
    const candidates: Omit<SkillSourceSuggestion, 'exists'>[] = [
      {
        path: path.join(home, '.claude', 'skills'),
        kind: 'claude',
        note: 'Claude Code personal skills (documented location).',
      },
      ...(claudeConfigDir
        ? [
            {
              path: path.join(claudeConfigDir, 'skills'),
              kind: 'claude' as const,
              note: 'Inside CLAUDE_CONFIG_DIR; not documented as a skills location — verify it.',
            },
          ]
        : []),
      {
        path: path.join(home, '.agents', 'skills'),
        kind: 'codex',
        note: 'Codex user skills (documented location).',
      },
      {
        path: path.join(home, '.codex', 'skills'),
        kind: 'codex',
        note: 'Codex folder found on some installations; hidden folders (.system) are skipped.',
      },
    ];
    const seen = new Set<string>();
    const result: SkillSourceSuggestion[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      result.push({ ...candidate, exists: (await this.fs.kind(candidate.path)) === 'directory' });
    }
    return result;
  }

  listSources(): Promise<SkillSource[]> {
    return this.repo.listSources();
  }

  /**
   * Authorizes a folder for discovery. `explicit` means the user chose this exact path
   * (native folder picker or CLI argument); otherwise only suggested folders are accepted.
   */
  async addSource(input: AddSkillSourceInput, explicit: boolean): Promise<SkillSource> {
    if (!explicit && !(await this.suggestions()).some((item) => item.path === input.path)) {
      throw unauthorized();
    }
    if ((await this.fs.kind(input.path)) !== 'directory') {
      throw invalid('path', 'The folder does not exist.');
    }
    const real = await this.fs.realpath(input.path);
    const existing = (await this.repo.listSources()).find((source) => source.path === real);
    if (existing) return existing;
    const source: SkillSource = {
      id: this.options.generateId(),
      path: real,
      kind: input.kind,
      enabled: true,
      addedAt: this.now(),
    };
    await this.repo.insertSource(source);
    return source;
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    if (!(await this.repo.setSourceEnabled(id, enabled))) throw notFound();
  }

  async removeSource(id: string): Promise<void> {
    if (!(await this.repo.removeSource(id))) throw notFound();
  }

  /** Skill folders in the enabled sources, with their registry status. */
  async discover(): Promise<DiscoveredSkill[]> {
    const skills = await this.repo.listSkills();
    const found: DiscoveredSkill[] = [];
    for (const source of (await this.repo.listSources()).filter((item) => item.enabled)) {
      for (const folder of await this.fs.skillFolders(source.path)) {
        try {
          const real = await this.fs.realpath(folder);
          const analysis = await this.analyze(real, skills);
          const registered = skills.find((skill) => skill.source.path === real) ?? null;
          found.push({
            path: real,
            sourceId: source.id,
            dirName: path.basename(real),
            name: analysis.name,
            description: analysis.description,
            status: !analysis.validation.valid
              ? 'invalid'
              : registered === null
                ? 'new'
                : (await this.currentHash(registered)) === analysis.contentHash
                  ? 'imported'
                  : 'update-available',
            skillId: registered?.id ?? null,
            issues: analysis.validation.issues.filter((issue) => issue.level !== 'info'),
          });
        } catch (error) {
          this.logger.warn('Skill folder could not be read', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Import and versions (FR-618, FR-623)
  // -------------------------------------------------------------------------

  /** What importing would do; nothing is copied. */
  async inspect(folder: string, explicit: boolean): Promise<SkillImportPreview> {
    const real = await this.authorize(folder, explicit);
    const skills = await this.repo.listSkills();
    const analysis = await this.analyze(real, skills);
    const existing =
      skills.find((skill) => skill.source.path === real) ??
      skills.find((skill) => skill.name === analysis.name) ??
      null;
    return {
      path: real,
      dirName: path.basename(real),
      name: analysis.name,
      description: analysis.description,
      version: analysis.version,
      contentHash: analysis.contentHash,
      files: analysis.files,
      totalSize: analysis.totalSize,
      validation: analysis.validation,
      existingSkillId: existing?.id ?? null,
      sameContent: existing !== null && (await this.currentHash(existing)) === analysis.contentHash,
    };
  }

  /**
   * Copies a reviewed folder into the registry: a new skill, or a new version of the
   * skill registered from the same folder. Refused when the folder changed after the
   * preview (`contentHash`) or when validation reports an error.
   */
  async import(input: ImportSkillInput, explicit: boolean): Promise<Skill> {
    const real = await this.authorize(input.path, explicit);
    const skills = await this.repo.listSkills();
    const analysis = await this.analyze(real, skills);
    if (analysis.contentHash !== input.contentHash) {
      throw invalid('contentHash', 'The folder changed since it was reviewed. Review it again.');
    }
    if (!analysis.validation.valid) {
      throw new AtlasError('SKILL_REJECTED', undefined, {
        issues: analysis.validation.issues
          .filter((issue) => issue.level === 'error')
          .map((issue) => ({ field: issue.code, message: issue.message })),
      });
    }
    const existing = skills.find((skill) => skill.source.path === real);
    if (existing) {
      if ((await this.currentHash(existing)) === analysis.contentHash) return existing;
      return this.addVersion(existing, real, analysis, input.note ?? null);
    }
    if (skills.some((skill) => skill.dirName === analysis.dirName)) {
      throw invalid('name', `A skill named "${analysis.name}" is already registered.`);
    }
    const kind: SkillSourceKind =
      (await this.repo.listSources()).find((source) => inside(source.path, real))?.kind ?? 'path';
    return this.createSkill(
      analysis,
      { kind, path: real, templateId: null },
      real,
      input.note ?? null,
    );
  }

  /** Every skill in the sub-folders of a folder (e.g. a skills repository). */
  async inspectCollection(folder: string, explicit: boolean): Promise<SkillCollectionPreview> {
    const root = await this.authorize(folder, explicit);
    const skills: SkillImportPreview[] = [];
    for (const child of await this.fs.skillFolders(root)) {
      const real = await this.fs.realpath(child);
      // A sub-folder linked to somewhere else is not part of the chosen folder.
      if (!inside(root, real)) continue;
      skills.push(await this.inspect(real, true));
    }
    return { path: root, skills };
  }

  /**
   * Imports reviewed skills of a folder in one go: the folder becomes a source (so
   * changes show as updates), each skill is copied as in `import`, and optionally
   * enabled. A skill that fails is reported; the others are still imported.
   */
  async importCollection(
    input: ImportSkillCollectionInput,
    explicit: boolean,
  ): Promise<SkillCollectionResult> {
    const root = await this.authorize(input.path, explicit);
    const source = await this.addSource({ path: root, kind: 'path' }, true);
    const imported: Skill[] = [];
    const failed: SkillCollectionResult['failed'] = [];
    for (const item of input.items) {
      const name = path.basename(item.path);
      try {
        const real = await this.fs.realpath(item.path);
        if (real === root || !inside(root, real)) {
          throw invalid('items', 'The skill is not inside the chosen folder.');
        }
        let skill = await this.import(
          { path: real, confirm: true, contentHash: item.contentHash },
          true,
        );
        if (input.enable && !skill.enabled) skill = await this.setEnabled(skill.id, true);
        imported.push(skill);
      } catch (error) {
        failed.push({
          path: item.path,
          name,
          message:
            error instanceof AtlasError
              ? error.issues.map((issue) => issue.message).join(' ') || error.userMessage
              : 'The skill could not be imported.',
        });
      }
    }
    return { sourceId: source.id, imported, failed };
  }

  /** Whether the source folder now differs from the current version; null if unreadable. */
  async updateAvailable(skill: Skill): Promise<boolean | null> {
    if (skill.source.path === null) return null;
    try {
      const snapshot = await this.fs.snapshot(skill.source.path);
      const analysis = analyzeSkill(snapshot, this.environment([]));
      return analysis.contentHash !== (await this.currentHash(skill));
    } catch {
      return null;
    }
  }

  templates(): SkillTemplate[] {
    return listTemplates();
  }

  /** A new, editable skill owned by ATLAS from a built-in template (FR-625). */
  async createFromTemplate(input: CreateSkillFromTemplateInput): Promise<Skill> {
    const content = templateSkillFile(input.templateId, input.name);
    if (content === null) throw invalid('templateId', 'Unknown template.');
    const skills = await this.repo.listSkills();
    if (skills.some((skill) => skill.dirName === input.name)) {
      throw invalid('name', `A skill named "${input.name}" is already registered.`);
    }
    const draft = path.join(this.options.storageRoot, '.drafts', this.options.generateId());
    await this.fs.writeFile(path.join(draft, 'SKILL.md'), content);
    try {
      const analysis = await this.analyze(draft, skills);
      return await this.createSkill(
        analysis,
        { kind: 'template', path: null, templateId: input.templateId },
        draft,
        null,
      );
    } finally {
      await this.fs.removeDirectory(draft);
    }
  }

  /** Saves new SKILL.md content of a skill created in ATLAS as a new version. */
  async edit(input: EditSkillInput): Promise<Skill> {
    const skill = await this.requireSkill(input.skillId);
    if (skill.source.kind !== 'template' && skill.source.kind !== 'atlas') {
      throw invalid(
        'skillId',
        'Only skills created in ATLAS can be edited; change imported skills at their source.',
      );
    }
    const current = await this.requireVersion(skill.id, skill.currentSequence);
    const draft = path.join(this.options.storageRoot, '.drafts', this.options.generateId());
    const others = current.files.map((file) => file.path).filter((file) => file !== 'SKILL.md');
    await this.fs.copyFiles(current.storagePath, draft, others);
    await this.fs.writeFile(path.join(draft, 'SKILL.md'), input.content);
    try {
      const analysis = await this.analyze(draft, await this.repo.listSkills());
      if (!analysis.validation.valid) {
        throw new AtlasError('SKILL_REJECTED', undefined, {
          issues: analysis.validation.issues
            .filter((issue) => issue.level === 'error')
            .map((issue) => ({ field: issue.code, message: issue.message })),
        });
      }
      if (analysis.contentHash === current.contentHash) return skill;
      return await this.addVersion(skill, draft, analysis, input.note ?? null);
    } finally {
      await this.fs.removeDirectory(draft);
    }
  }

  // -------------------------------------------------------------------------
  // Registry (FR-614, FR-622)
  // -------------------------------------------------------------------------

  listSkills(): Promise<Skill[]> {
    return this.repo.listSkills();
  }

  async details(id: string): Promise<SkillDetails> {
    const skill = await this.requireSkill(id);
    const versions = await this.repo.listVersions(id);
    return {
      skill,
      versions: versions.map(({ skillMd: _md, storagePath: _path, ...version }) => version),
      updateAvailable: await this.updateAvailable(skill),
    };
  }

  /** A file of a stored version, read-only; never a path outside that version. */
  async readFile(id: string, sequence: number, file: string): Promise<SkillFileContent> {
    const version = await this.requireVersion(id, sequence);
    if (!version.files.some((item) => item.path === file)) throw notFound();
    const { content, truncated } = await this.fs.readText(
      path.join(version.storagePath, ...file.split('/')),
      VIEW_LIMIT,
    );
    return { path: file, content, truncated };
  }

  async diff(id: string, from: number, to: number): Promise<SkillDiff> {
    const [before, after] = await Promise.all([
      this.requireVersion(id, from),
      this.requireVersion(id, to),
    ]);
    const { lines, truncated } = diffLines(before.skillMd, after.skillMd);
    return { from, to, lines, files: diffFiles(before.files, after.files), truncated };
  }

  /** Runs the checks again on the current version (dependencies may have changed). */
  async validate(id: string): Promise<Skill> {
    const skill = await this.requireSkill(id);
    const analysis = await this.analyze(skill.storagePath, await this.repo.listSkills());
    const next: Skill = { ...skill, validation: analysis.validation, updatedAt: this.now() };
    await this.repo.updateSkill(next);
    return next;
  }

  async setEnabled(id: string, enabled: boolean): Promise<Skill> {
    const skill = await this.requireSkill(id);
    if (enabled && !skill.validation.valid) {
      throw invalid('enabled', 'A skill that failed validation cannot be enabled.');
    }
    const next: Skill = { ...skill, enabled, updatedAt: this.now() };
    await this.repo.updateSkill(next);
    return next;
  }

  async assign(input: SkillAssignmentInput): Promise<Skill> {
    await this.requireSkill(input.skillId);
    await this.repo.setAssignment({ ...input, createdAt: this.now() });
    return this.requireSkill(input.skillId);
  }

  async unassign(input: RemoveSkillAssignmentInput): Promise<Skill> {
    await this.requireSkill(input.skillId);
    await this.repo.removeAssignment(input.skillId, input.scope, input.target);
    return this.requireSkill(input.skillId);
  }

  /**
   * Removes the registry entry and ATLAS's own copies. The source folder is never
   * touched; copies synchronized to providers must be rolled back or removed first.
   */
  async remove(id: string): Promise<void> {
    const skill = await this.requireSkill(id);
    if (await this.isSynchronized(skill.id)) {
      throw invalid(
        'skillId',
        'This skill is synchronized to a provider. Disable it and synchronize again first.',
      );
    }
    await this.repo.removeSkill(id);
    await this.fs.removeDirectory(path.join(this.options.storageRoot, skill.id));
  }

  /** A removed project's assignments go with it; the skills stay registered. */
  async projectRemoved(projectId: string): Promise<void> {
    await this.repo.removeAssignmentsFor('project', projectId);
  }

  /** Activation of every registered skill for a context (FR-619). */
  async resolve(context: ResolutionContext): Promise<ResolvedSkill[]> {
    return (await this.repo.listSkills()).map((skill) =>
      resolveSkill(skill, context, path.join(skill.storagePath, 'SKILL.md')),
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Overridden by the synchronization layer. */
  protected async isSynchronized(_skillId: string): Promise<boolean> {
    return false;
  }

  protected async requireSkill(id: string): Promise<Skill> {
    const skill = await this.repo.getSkill(id);
    if (skill === null) throw notFound();
    return skill;
  }

  protected async requireVersion(id: string, sequence: number): Promise<StoredSkillVersion> {
    const version = await this.repo.getVersion(id, sequence);
    if (version === null) throw notFound();
    return version;
  }

  private async currentHash(skill: Skill): Promise<string | null> {
    return (await this.repo.getVersion(skill.id, skill.currentSequence))?.contentHash ?? null;
  }

  /** A folder may be read when the user chose it, or when it is in an enabled source. */
  private async authorize(folder: string, explicit: boolean): Promise<string> {
    if ((await this.fs.kind(folder)) !== 'directory') {
      throw invalid('path', 'The folder does not exist.');
    }
    const real = await this.fs.realpath(folder);
    if (explicit) return real;
    const sources = (await this.repo.listSources()).filter((source) => source.enabled);
    if (!sources.some((source) => inside(source.path, real))) throw unauthorized();
    return real;
  }

  private environment(skills: Skill[]) {
    return {
      hasExecutable: (name: string) => this.fs.hasExecutable(name),
      skillNames: new Set(skills.map((skill) => skill.name)),
      now: this.options.clock.now(),
    };
  }

  private async analyze(folder: string, skills: Skill[]): Promise<SkillAnalysis> {
    return analyzeSkill(await this.fs.snapshot(folder), this.environment(skills));
  }

  /** Version label; edits that keep `metadata.version` get the content hash appended. */
  private label(analysis: SkillAnalysis, previous: string | null): string {
    return previous !== null && analysis.version === previous
      ? `${analysis.version}+${analysis.contentHash.slice(0, 8)}`
      : analysis.version;
  }

  private async storeVersion(
    skillId: string,
    sequence: number,
    from: string,
    analysis: SkillAnalysis,
    note: string | null,
    previousLabel: string | null,
  ): Promise<StoredSkillVersion> {
    const storagePath = path.join(this.options.storageRoot, skillId, String(sequence));
    await this.fs.copyFiles(
      from,
      storagePath,
      analysis.files.map((file) => file.path),
    );
    const skillMd = (await this.fs.readText(path.join(storagePath, 'SKILL.md'), VIEW_LIMIT))
      .content;
    return {
      skillId,
      sequence,
      version: this.label(analysis, previousLabel),
      contentHash: analysis.contentHash,
      name: analysis.name,
      description: analysis.description,
      files: analysis.files,
      validation: analysis.validation,
      note,
      importedAt: this.now(),
      skillMd: skillMd ?? '',
      storagePath,
    };
  }

  private async createSkill(
    analysis: SkillAnalysis,
    source: Skill['source'],
    from: string,
    note: string | null,
  ): Promise<Skill> {
    const id = this.options.generateId();
    const version = await this.storeVersion(id, 1, from, analysis, note, null);
    const now = this.now();
    const skill: Skill = {
      id,
      name: analysis.name,
      description: analysis.description,
      dirName: analysis.dirName,
      version: version.version,
      currentSequence: 1,
      source,
      // New skills are off until the user enables them.
      enabled: false,
      assignments: [],
      validation: analysis.validation,
      storagePath: version.storagePath,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertSkill(skill, version);
    return skill;
  }

  private async addVersion(
    skill: Skill,
    from: string,
    analysis: SkillAnalysis,
    note: string | null,
  ): Promise<Skill> {
    const sequence = skill.currentSequence + 1;
    const version = await this.storeVersion(
      skill.id,
      sequence,
      from,
      analysis,
      note,
      skill.version,
    );
    const next: Skill = {
      ...skill,
      name: analysis.name,
      description: analysis.description,
      version: version.version,
      currentSequence: sequence,
      validation: analysis.validation,
      storagePath: version.storagePath,
      updatedAt: this.now(),
    };
    await this.repo.addVersion(next, version);
    return next;
  }
}
