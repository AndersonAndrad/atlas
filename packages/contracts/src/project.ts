import { z } from 'zod';

export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 1000;
export const PROJECT_TAG_MAX_LENGTH = 32;
export const PROJECT_TAGS_MAX_COUNT = 20;
export const WORKSPACE_PATH_MAX_LENGTH = 4096;

export const ProjectIdSchema = z.uuid({ message: 'Invalid project identifier.' });

const NameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(PROJECT_NAME_MAX_LENGTH, `Name must be at most ${PROJECT_NAME_MAX_LENGTH} characters.`);

const DescriptionSchema = z
  .string()
  .trim()
  .max(
    PROJECT_DESCRIPTION_MAX_LENGTH,
    `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters.`,
  );

const TagSchema = z
  .string()
  .trim()
  .min(1, 'Tags cannot be empty.')
  .max(PROJECT_TAG_MAX_LENGTH, `Tags must be at most ${PROJECT_TAG_MAX_LENGTH} characters.`)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}._\-/ ]*$/u,
    'Tags may contain letters, numbers, spaces, ".", "_", "-" and "/".',
  );

const TagsSchema = z
  .array(TagSchema)
  .max(PROJECT_TAGS_MAX_COUNT, `At most ${PROJECT_TAGS_MAX_COUNT} tags are allowed.`)
  .transform((tags) => {
    // Case-insensitive de-duplication that keeps the first spelling.
    const seen = new Set<string>();
    return tags.filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const WorkspacePathSchema = z
  .string()
  .min(1, 'A directory is required.')
  .max(WORKSPACE_PATH_MAX_LENGTH, 'The directory path is too long.')
  .refine((value) => !value.includes('\0'), 'The directory path contains invalid characters.')
  .refine((value) => value.trim().length > 0, 'A directory is required.');

export const CreateProjectInputSchema = z.strictObject({
  name: NameSchema,
  workspacePath: WorkspacePathSchema,
  description: DescriptionSchema.optional(),
  tags: TagsSchema.default([]),
});

export const UpdateProjectInputSchema = z
  .strictObject({
    name: NameSchema.optional(),
    workspacePath: WorkspacePathSchema.optional(),
    /** `null` clears the description. */
    description: DescriptionSchema.nullable().optional(),
    tags: TagsSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one field must be provided.',
  });

export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;
export type ParsedCreateProjectInput = z.output<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.input<typeof UpdateProjectInputSchema>;
export type ParsedUpdateProjectInput = z.output<typeof UpdateProjectInputSchema>;

export const ProjectGitSchema = z.object({
  isRepository: z.boolean(),
  repositoryRoot: z.string().optional(),
});

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  workspacePath: z.string(),
  git: ProjectGitSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastOpenedAt: z.iso.datetime().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const AVAILABILITY_STATUSES = [
  'available',
  'missing',
  'not-a-directory',
  'permission-denied',
] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/** Dynamic, point-in-time state of a project's directory. */
export interface ProjectAvailability {
  status: AvailabilityStatus;
  checkedAt: string;
}

/** Live Git information read from disk when requested. */
export interface GitInspection {
  isRepository: boolean;
  repositoryRoot?: string;
  /** Current branch name, or undefined for detached HEAD or unreadable state. */
  branch?: string;
  detached?: boolean;
}

export interface ProjectPathInspection {
  /** The path exactly as supplied. */
  inputPath: string;
  /** Absolute, symlink-resolved path when the directory exists. */
  resolvedPath?: string;
  availability: ProjectAvailability;
  git: GitInspection;
  /** Suggested project name derived from the directory name. */
  suggestedName?: string;
}

/** A project combined with its live availability and Git state. */
export interface ProjectDetails {
  project: Project;
  availability: ProjectAvailability;
  git: GitInspection;
  isSelected: boolean;
}
