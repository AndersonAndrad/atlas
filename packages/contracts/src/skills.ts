import { z } from 'zod';
import { AGENT_ROLES, AI_PROVIDERS, type AiProvider } from './context.js';

// ---------------------------------------------------------------------------
// Skills Hub (SDD-006 Milestone B)
// ---------------------------------------------------------------------------

/** Where a skill came from. `atlas` skills were created in ATLAS (e.g. from a template). */
export const SKILL_SOURCE_KINDS = ['claude', 'codex', 'path', 'template', 'atlas'] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

/** Kinds of folders the user can authorize for discovery. */
export const SKILL_FOLDER_KINDS = ['claude', 'codex', 'path'] as const;
export type SkillFolderKind = (typeof SKILL_FOLDER_KINDS)[number];

/** Narrower activation scopes; the global default is the skill's `enabled` flag. */
export const SKILL_SCOPES = ['project', 'provider', 'role', 'session'] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];
export type SkillAssignmentEffect = 'enable' | 'disable';

export interface SkillIssue {
  level: 'error' | 'warning' | 'info';
  /** Stable identifier, e.g. `missing-description`. */
  code: string;
  message: string;
}

/** What a provider adapter found in the skill's format (FR-617). */
export interface SkillCompatibility {
  provider: AiProvider;
  /** `partial`: usable, but some features are ignored by this provider. */
  status: 'compatible' | 'partial' | 'incompatible';
  issues: SkillIssue[];
  /** Features of the skill this provider does not support (e.g. `allowed-tools` in Codex). */
  unsupportedFeatures: string[];
}

export interface SkillFile {
  /** Relative to the skill folder, with `/` separators. */
  path: string;
  size: number;
  /** SHA-256 of the content. */
  hash: string;
  /** Looks executable: execute permission, a shebang or a script extension. */
  script: boolean;
}

/** A declared dependency checked without running anything (FR-620). */
export interface SkillDependencyCheck {
  kind: 'executable' | 'tool' | 'skill' | 'provider';
  name: string;
  status: 'available' | 'missing' | 'unknown';
  detail: string | null;
}

/** Result of validating one version of a skill (FR-621). */
export interface SkillValidation {
  checkedAt: string;
  /** False when an error blocks importing or activating the skill. */
  valid: boolean;
  issues: SkillIssue[];
  compatibility: SkillCompatibility[];
  dependencies: SkillDependencyCheck[];
  /** Files that look executable. ATLAS never runs them. */
  scripts: string[];
  /** Tool permissions the skill asks providers for (e.g. Claude Code `allowed-tools`). */
  permissions: string[];
}

export interface SkillVersion {
  skillId: string;
  /** Increasing number of the import (1, 2, …). */
  sequence: number;
  /** The skill's own version (`metadata.version`) or a short content hash. */
  version: string;
  contentHash: string;
  name: string;
  description: string;
  files: SkillFile[];
  validation: SkillValidation;
  note: string | null;
  importedAt: string;
}

export interface SkillAssignment {
  skillId: string;
  scope: SkillScope;
  /** Project id, provider, role or AI session id. */
  target: string;
  effect: SkillAssignmentEffect;
  createdAt: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Folder name used when the skill is synchronized to a provider. */
  dirName: string;
  version: string;
  currentSequence: number;
  source: {
    kind: SkillSourceKind;
    /** Original folder (never modified by ATLAS); null for skills created in ATLAS. */
    path: string | null;
    templateId: string | null;
  };
  /** Global default: active wherever no narrower rule applies. */
  enabled: boolean;
  assignments: SkillAssignment[];
  /** Validation of the current version. */
  validation: SkillValidation;
  /** Folder of the current version in the ATLAS data directory. */
  storagePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetails {
  skill: Skill;
  /** Newest first. */
  versions: SkillVersion[];
  /** The source folder differs from the current version; null when it cannot be checked. */
  updateAvailable: boolean | null;
}

export interface SkillSource {
  id: string;
  path: string;
  kind: SkillFolderKind;
  enabled: boolean;
  addedAt: string;
}

/** A provider folder ATLAS knows about; it is inspected only after the user adds it. */
export interface SkillSourceSuggestion {
  path: string;
  kind: SkillFolderKind;
  exists: boolean;
  /** Why it is suggested and how sure ATLAS is about it. */
  note: string;
}

export interface DiscoveredSkill {
  path: string;
  sourceId: string;
  dirName: string;
  name: string;
  description: string;
  status: 'new' | 'imported' | 'update-available' | 'invalid';
  skillId: string | null;
  issues: SkillIssue[];
}

/** What importing a folder would do; shown for confirmation before anything is copied. */
export interface SkillImportPreview {
  path: string;
  dirName: string;
  name: string;
  description: string;
  version: string;
  contentHash: string;
  files: SkillFile[];
  totalSize: number;
  validation: SkillValidation;
  /** Registered skill with the same source folder or name. */
  existingSkillId: string | null;
  /** The existing skill's current version has the same content. */
  sameContent: boolean;
}

/** A folder of skills (e.g. a skills repository) reviewed before importing them all. */
export interface SkillCollectionPreview {
  path: string;
  skills: SkillImportPreview[];
}

export interface SkillCollectionResult {
  /** The folder is added as a source, so later changes show as updates. */
  sourceId: string;
  imported: Skill[];
  failed: { path: string; name: string; message: string }[];
}

export interface SkillFileContent {
  path: string;
  /** Null for binary files. */
  content: string | null;
  truncated: boolean;
}

export interface SkillDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface SkillDiff {
  from: number;
  to: number;
  /** SKILL.md line by line. */
  lines: SkillDiffLine[];
  files: { path: string; change: 'added' | 'removed' | 'changed' }[];
  /** The text was too long to compare line by line. */
  truncated: boolean;
}

/** Outcome of the activation rules for one skill (FR-619). */
export interface ResolvedSkill {
  skillId: string;
  name: string;
  description: string;
  version: string;
  active: boolean;
  /** Rule that decided, in precedence order. */
  layer: 'security' | 'project' | 'provider' | 'session' | 'role' | 'global' | 'none';
  reason: string;
  /** SKILL.md of the current version in the ATLAS data directory. */
  skillFile: string;
}

export interface SkillSyncTargets {
  claude: string | null;
  codex: string | null;
}

export type SkillSyncAction = 'create' | 'update' | 'remove' | 'unchanged' | 'conflict' | 'skip';

export interface SkillSyncItem {
  skillId: string | null;
  dirName: string;
  action: SkillSyncAction;
  reason: string;
  targetPath: string;
}

export interface SkillSyncPlan {
  provider: AiProvider;
  targetPath: string;
  items: SkillSyncItem[];
  generatedAt: string;
}

export interface SkillSyncResult {
  batchId: string;
  provider: AiProvider;
  applied: SkillSyncItem[];
  /** Items that changed between preview and apply, or failed; nothing was written for them. */
  skipped: SkillSyncItem[];
}

export interface SkillSyncBatch {
  batchId: string;
  provider: AiProvider;
  targetPath: string;
  appliedAt: string;
  rolledBackAt: string | null;
  changes: number;
}

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const Id = z.uuid();
const PathText = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Invalid path.');
/** Folder names usable by both providers. */
export const SkillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens.')
  .max(64);

export const SkillIdSchema = Id;

export const InspectSkillSchema = z.strictObject({ path: PathText });

export const ImportSkillSchema = z.strictObject({
  path: PathText,
  /** The user reviewed the preview (scripts, permissions, compatibility). */
  confirm: z.literal(true),
  /** Expected content; the import is refused if the folder changed after the preview. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().max(500).optional(),
});
export type ImportSkillInput = z.infer<typeof ImportSkillSchema>;

export const ImportSkillCollectionSchema = z.strictObject({
  /** The folder holding one skill per sub-folder. */
  path: PathText,
  confirm: z.literal(true),
  /** Reviewed skills and their content when reviewed; changed ones are refused. */
  items: z
    .array(z.strictObject({ path: PathText, contentHash: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(200),
  /** Enable the imported skills for every project right away. */
  enable: z.boolean(),
});
export type ImportSkillCollectionInput = z.infer<typeof ImportSkillCollectionSchema>;

export const SkillAssignmentSchema = z
  .strictObject({
    skillId: Id,
    scope: z.enum(SKILL_SCOPES),
    target: z.string().min(1).max(200),
    effect: z.enum(['enable', 'disable']),
  })
  .superRefine((value, context) => {
    const valid =
      value.scope === 'role'
        ? (AGENT_ROLES as readonly string[]).includes(value.target)
        : value.scope === 'provider'
          ? (AI_PROVIDERS as readonly string[]).includes(value.target)
          : z.uuid().safeParse(value.target).success;
    if (!valid) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: `Not a valid ${value.scope} for a skill assignment.`,
      });
    }
  });
export type SkillAssignmentInput = z.infer<typeof SkillAssignmentSchema>;

export const RemoveSkillAssignmentSchema = z.strictObject({
  skillId: Id,
  scope: z.enum(SKILL_SCOPES),
  target: z.string().min(1).max(200),
});
export type RemoveSkillAssignmentInput = z.infer<typeof RemoveSkillAssignmentSchema>;

export const ResolveSkillsSchema = z.strictObject({
  projectId: Id.optional(),
  provider: z.enum([...AI_PROVIDERS, 'generic']).optional(),
  role: z.enum(AGENT_ROLES).optional(),
  /** Skills chosen for one session (e.g. in the Start dialog). */
  sessionSkillIds: z.array(Id).max(100).optional(),
  sessionId: Id.optional(),
});
export type ResolveSkillsInput = z.infer<typeof ResolveSkillsSchema>;

export const AddSkillSourceSchema = z.strictObject({
  path: PathText,
  kind: z.enum(SKILL_FOLDER_KINDS),
});
export type AddSkillSourceInput = z.infer<typeof AddSkillSourceSchema>;

export const SkillSyncTargetsSchema = z
  .strictObject({ claude: PathText.nullable(), codex: PathText.nullable() })
  .partial();
export type UpdateSkillSyncTargets = z.infer<typeof SkillSyncTargetsSchema>;

export const CreateSkillFromTemplateSchema = z.strictObject({
  templateId: z.string().min(1).max(100),
  name: SkillNameSchema,
});
export type CreateSkillFromTemplateInput = z.infer<typeof CreateSkillFromTemplateSchema>;

export const EditSkillSchema = z.strictObject({
  skillId: Id,
  /** New SKILL.md content; only skills created in ATLAS can be edited. */
  content: z
    .string()
    .min(1)
    .max(256 * 1024),
  note: z.string().trim().max(500).optional(),
});
export type EditSkillInput = z.infer<typeof EditSkillSchema>;

export const SkillDiffSchema = z.strictObject({
  skillId: Id,
  from: z.number().int().min(1),
  to: z.number().int().min(1),
});

export const ReadSkillFileSchema = z.strictObject({
  skillId: Id,
  sequence: z.number().int().min(1),
  path: z.string().min(1).max(1024),
});
