import path from 'node:path';
import {
  SkillSyncTargetsSchema,
  parseInput,
  type AiProvider,
  type Skill,
  type SkillSyncBatch,
  type SkillSyncItem,
  type SkillSyncPlan,
  type SkillSyncResult,
  type SkillSyncTargets,
} from '@atlas/contracts';
import { AtlasError, describeError } from '@atlas/shared';
import { usableBy } from './analyze.js';
import type { SkillSyncChange } from './ports.js';
import { SkillsService, type SkillsServiceOptions } from './service.js';

/** Written into every folder ATLAS synchronizes; folders without it are never touched. */
export const MANAGED_MARKER = '.atlas-managed.json';
export const SYNC_TARGETS_KEY = 'skills.syncTargets';

interface ManagedMarker {
  managedBy: 'atlas';
  skillId: string;
  sequence: number;
  contentHash: string;
  batchId: string;
}

export interface SkillsHubOptions extends SkillsServiceOptions {
  /** Application settings (`application_settings`). */
  settings: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
}

const invalid = (field: string, message: string) =>
  new AtlasError('VALIDATION_FAILED', message, { issues: [{ field, message }] });

/**
 * Skills Hub with explicit synchronization to provider folders (FR-624). Only
 * user-level folders chosen by the user are written; only globally enabled skills
 * usable by the provider are synchronized; folders ATLAS did not create are reported
 * as conflicts and never changed. Every change can be rolled back.
 */
export class SkillsHub extends SkillsService {
  constructor(private readonly hubOptions: SkillsHubOptions) {
    super(hubOptions);
  }

  async syncTargets(): Promise<SkillSyncTargets> {
    const raw = await this.hubOptions.settings.get(SYNC_TARGETS_KEY);
    try {
      const value = raw === null ? {} : (JSON.parse(raw) as Partial<SkillSyncTargets>);
      return { claude: value.claude ?? null, codex: value.codex ?? null };
    } catch {
      this.logger.warn('Stored skill sync targets are invalid; using none');
      return { claude: null, codex: null };
    }
  }

  async setSyncTargets(input: unknown): Promise<SkillSyncTargets> {
    const changes = parseInput(SkillSyncTargetsSchema, input);
    for (const [provider, target] of Object.entries(changes)) {
      if (target !== null && target !== undefined && !path.isAbsolute(target)) {
        throw invalid(provider, 'Use an absolute folder path.');
      }
    }
    const next = { ...(await this.syncTargets()), ...changes };
    await this.hubOptions.settings.set(SYNC_TARGETS_KEY, JSON.stringify(next));
    return next;
  }

  /** What synchronizing would change; nothing is written. */
  async syncPreview(provider: AiProvider): Promise<SkillSyncPlan> {
    const target = await this.requireTarget(provider);
    return {
      provider,
      targetPath: target,
      items: await this.plan(provider, target),
      generatedAt: this.now(),
    };
  }

  /**
   * Applies the plan computed now. Items that are not `create`, `update` or `remove`
   * are left alone; a failure stops that item only and is reported as skipped.
   */
  async syncApply(provider: AiProvider): Promise<SkillSyncResult> {
    const target = await this.requireTarget(provider);
    const items = await this.plan(provider, target);
    const batchId = this.options.generateId();
    const backups = path.join(this.options.storageRoot, '.sync-backups', batchId);
    const applied: SkillSyncItem[] = [];
    const skipped: SkillSyncItem[] = [];
    const changes: SkillSyncChange[] = [];
    const skills = new Map((await this.repo.listSkills()).map((skill) => [skill.id, skill]));

    for (const item of items) {
      if (item.action !== 'create' && item.action !== 'update' && item.action !== 'remove')
        continue;
      try {
        // The folder is checked again right before it is changed.
        const marker = await this.marker(item.targetPath);
        const kind = await this.fs.kind(item.targetPath);
        if (item.action === 'create' ? kind !== null : marker === null) {
          skipped.push({
            ...item,
            action: 'conflict',
            reason: 'The folder changed since the preview.',
          });
          continue;
        }
        let backupPath: string | null = null;
        if (item.action !== 'create') {
          backupPath = path.join(backups, item.dirName);
          await this.fs.move(item.targetPath, backupPath);
        }
        if (item.action !== 'remove') {
          await this.writeManaged(skills.get(item.skillId!)!, item.targetPath, batchId);
        }
        changes.push({
          skillId: item.skillId,
          dirName: item.dirName,
          action: item.action,
          targetPath: item.targetPath,
          backupPath,
        });
        applied.push(item);
      } catch (error) {
        this.logger.warn('Skill could not be synchronized', {
          provider,
          error: describeError(error),
        });
        skipped.push({ ...item, reason: 'Writing the folder failed; see the ATLAS log.' });
      }
    }
    if (changes.length > 0) {
      await this.repo.insertSyncBatch(
        {
          batchId,
          provider,
          targetPath: target,
          appliedAt: this.now(),
          rolledBackAt: null,
          changes: changes.length,
        },
        changes,
      );
    }
    return { batchId, provider, applied, skipped };
  }

  syncHistory(provider?: AiProvider): Promise<SkillSyncBatch[]> {
    return this.repo.listSyncBatches(provider);
  }

  /**
   * Undoes the latest synchronization of a provider: created folders are removed and
   * replaced or removed folders are restored. Folders changed since (no ATLAS marker
   * from that synchronization) are left alone and reported.
   */
  async syncRollback(batchId: string): Promise<{ restored: string[]; skipped: string[] }> {
    const batches = await this.repo.listSyncBatches();
    const batch = batches.find((item) => item.batchId === batchId);
    if (batch === undefined) throw new AtlasError('SKILL_NOT_FOUND');
    if (batch.rolledBackAt !== null)
      throw invalid('batchId', 'This synchronization was already rolled back.');
    const latest = batches.find(
      (item) => item.provider === batch.provider && item.rolledBackAt === null,
    );
    if (latest?.batchId !== batchId) {
      throw invalid('batchId', 'Only the latest synchronization of a provider can be rolled back.');
    }
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const change of [...(await this.repo.syncChanges(batchId))].reverse()) {
      const marker = await this.marker(change.targetPath);
      const present = await this.fs.kind(change.targetPath);
      if (change.action !== 'remove') {
        if (marker?.batchId !== batchId) {
          skipped.push(change.dirName);
          continue;
        }
        await this.fs.removeDirectory(change.targetPath);
      } else if (present !== null) {
        skipped.push(change.dirName);
        continue;
      }
      if (change.backupPath !== null) await this.fs.move(change.backupPath, change.targetPath);
      restored.push(change.dirName);
    }
    await this.repo.markRolledBack(batchId, this.now());
    return { restored, skipped };
  }

  protected override async isSynchronized(skillId: string): Promise<boolean> {
    const targets = await this.syncTargets();
    for (const target of [targets.claude, targets.codex]) {
      if (target === null) continue;
      for (const folder of await this.fs.skillFolders(target)) {
        if ((await this.marker(folder))?.skillId === skillId) return true;
      }
    }
    return false;
  }

  private async requireTarget(provider: AiProvider): Promise<string> {
    const target = (await this.syncTargets())[provider];
    if (target === null) {
      throw invalid(
        'provider',
        `Choose the ${provider === 'claude' ? 'Claude Code' : 'Codex'} skills folder first.`,
      );
    }
    return target;
  }

  private async marker(folder: string): Promise<ManagedMarker | null> {
    const file = path.join(folder, MANAGED_MARKER);
    if ((await this.fs.kind(file)) !== 'file') return null;
    try {
      const { content } = await this.fs.readText(file, 4096);
      const value = JSON.parse(content ?? '') as Partial<ManagedMarker>;
      return value.managedBy === 'atlas' &&
        typeof value.skillId === 'string' &&
        typeof value.batchId === 'string'
        ? (value as ManagedMarker)
        : null;
    } catch {
      return null;
    }
  }

  /** Which skills should be in the provider folder, compared with what is there. */
  private async plan(provider: AiProvider, target: string): Promise<SkillSyncItem[]> {
    const skills = await this.repo.listSkills();
    const desired = skills.filter(
      (skill) =>
        skill.enabled &&
        usableBy(skill.validation, provider) &&
        !skill.assignments.some(
          (item) =>
            item.scope === 'provider' && item.target === provider && item.effect === 'disable',
        ),
    );
    const items: SkillSyncItem[] = [];
    const claimed = new Set<string>();
    for (const skill of desired) {
      const targetPath = path.join(target, skill.dirName);
      const base = { skillId: skill.id, dirName: skill.dirName, targetPath };
      if (claimed.has(skill.dirName)) {
        items.push({
          ...base,
          action: 'conflict',
          reason: 'Another enabled skill uses the same folder name.',
        });
        continue;
      }
      claimed.add(skill.dirName);
      const kind = await this.fs.kind(targetPath);
      if (kind === null) {
        items.push({ ...base, action: 'create', reason: 'Not in the provider folder yet.' });
        continue;
      }
      const marker = await this.marker(targetPath);
      if (marker === null || marker.skillId !== skill.id) {
        items.push({
          ...base,
          action: 'conflict',
          reason: 'A folder with this name exists and was not created by ATLAS for this skill.',
        });
        continue;
      }
      const version = await this.repo.getVersion(skill.id, skill.currentSequence);
      items.push(
        marker.contentHash === version?.contentHash
          ? { ...base, action: 'unchanged', reason: `Version ${skill.version} is already there.` }
          : { ...base, action: 'update', reason: `Replace with version ${skill.version}.` },
      );
    }
    const wanted = new Set(desired.map((skill) => skill.id));
    for (const folder of await this.fs.skillFolders(target)) {
      const marker = await this.marker(folder);
      if (marker === null || wanted.has(marker.skillId)) continue;
      items.push({
        skillId: marker.skillId,
        dirName: path.basename(folder),
        action: 'remove',
        reason: 'Synchronized by ATLAS before; the skill is no longer enabled for this provider.',
        targetPath: folder,
      });
    }
    return items;
  }

  private async writeManaged(skill: Skill, targetPath: string, batchId: string): Promise<void> {
    const version = await this.requireVersion(skill.id, skill.currentSequence);
    // Written beside the target and renamed, so a failure never leaves a partial skill.
    const staging = path.join(
      path.dirname(targetPath),
      `.atlas-staging-${batchId.slice(0, 8)}-${path.basename(targetPath)}`,
    );
    await this.fs.copyFiles(
      version.storagePath,
      staging,
      version.files.map((file) => file.path),
    );
    const marker: ManagedMarker = {
      managedBy: 'atlas',
      skillId: skill.id,
      sequence: version.sequence,
      contentHash: version.contentHash,
      batchId,
    };
    await this.fs.writeFile(
      path.join(staging, MANAGED_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
    try {
      await this.fs.move(staging, targetPath);
    } catch (error) {
      await this.fs.removeDirectory(staging);
      throw error;
    }
  }
}
