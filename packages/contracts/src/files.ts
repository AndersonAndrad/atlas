import { z } from 'zod';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// Project files and the code editor (SDD-011 Milestone A, PLAN-033)
// ---------------------------------------------------------------------------

/** Largest file the editor opens (PLAN-033 Q4). */
export const FILE_EDITABLE_MAX_BYTES = 5 * 1024 * 1024;
export const FILE_PATH_MAX = 4096;
/** Bytes of one file or folder name (the usual filesystem limit). */
export const FILE_NAME_MAX_BYTES = 255;
/** Entries returned for one folder; larger folders are cut. */
export const FILE_LIST_MAX = 5000;
export const FILE_FIND_QUERY_MAX = 200;
export const FILE_FIND_LIMIT_MAX = 100;
/** Folders one client watches at a time. */
export const FILE_WATCH_MAX = 200;
export const FILE_VERSIONS_MAX = 100;
/** Tabs remembered per project. */
export const EDITOR_LAYOUT_TABS_MAX = 50;

const encoder = new TextEncoder();

/** Whether `name` can be one segment of a path: not empty, `.`, `..`, nor contain `/` or NUL. */
export function isValidFileName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0') &&
    encoder.encode(name).length <= FILE_NAME_MAX_BYTES
  );
}

/**
 * Whether `path` is a `/`-separated path relative to the project folder; `''` is the folder
 * itself. Absolute paths and `.`/`..` segments are rejected, so a path cannot leave the
 * folder by its spelling (symbolic links are checked by the Engine).
 */
export function isRelativeFilePath(path: string): boolean {
  if (path === '') return true;
  return path.length <= FILE_PATH_MAX && path.split('/').every(isValidFileName);
}

export const RelativeFilePathSchema = z
  .string()
  .max(FILE_PATH_MAX)
  .refine(isRelativeFilePath, 'Use a path inside the project, without "." or ".." segments.');

/** A file or folder other than the project folder itself. */
const EntryPathSchema = RelativeFilePathSchema.refine((path) => path !== '', 'Choose a file.');

export const FileNameSchema = z
  .string()
  .refine(isValidFileName, 'Use a name without "/", and not "." or "..".');

export const FileRefSchema = z.strictObject({ projectId: ProjectIdSchema, path: EntryPathSchema });
export type FileRef = z.infer<typeof FileRefSchema>;

export type FileEntryKind = 'file' | 'directory' | 'other';

export interface FileEntry {
  name: string;
  /** Relative to the project folder. */
  path: string;
  kind: FileEntryKind;
  /** A symbolic link; `outside` is set when it points outside the project folder. */
  symlink: boolean;
  outside: boolean;
  /** Matched by the project's ignore rules (Git) or the default list (FR-1103). */
  ignored: boolean;
}

export const ListDirectorySchema = z.strictObject({
  projectId: ProjectIdSchema,
  path: RelativeFilePathSchema,
  showIgnored: z.boolean().optional(),
  showHidden: z.boolean().optional(),
});
export type ListDirectoryInput = z.infer<typeof ListDirectorySchema>;

export interface DirectoryListing {
  path: string;
  /** Folders first, then by name. */
  entries: FileEntry[];
  /** More than FILE_LIST_MAX entries: the rest are not listed. */
  truncated: boolean;
  /** Entries hidden because they are ignored (shown with `showIgnored`). */
  hiddenIgnored: number;
}

export const FILE_ENCODINGS = ['utf8', 'utf8bom', 'utf16le', 'utf16be'] as const;
export type FileEncoding = (typeof FILE_ENCODINGS)[number];
export type FileEol = 'LF' | 'CRLF';

/** Identifies the bytes on disk: sha256 of the content (FR-1107). */
export const FileVersionSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid file version.');

export interface FileContent {
  path: string;
  content: string;
  encoding: FileEncoding;
  eol: FileEol;
  /** Both LF and CRLF occur; saving uses `eol` for every line. */
  mixedEol: boolean;
  version: string;
  size: number;
  /** ATLAS cannot write the file. */
  readOnly: boolean;
}

export const WriteFileSchema = z.strictObject({
  projectId: ProjectIdSchema,
  path: EntryPathSchema,
  /** Characters; the byte limit is checked after encoding. */
  content: z.string().max(FILE_EDITABLE_MAX_BYTES),
  encoding: z.enum(FILE_ENCODINGS),
  /**
   * The version the user edited. Null creates a new file and fails with
   * FILE_ALREADY_EXISTS when one exists.
   */
  expectedVersion: FileVersionSchema.nullable(),
  /** Writes whatever is on disk now; only after the user chose to (conflict or Save As). */
  overwrite: z.boolean().optional(),
});
export type WriteFileInput = z.infer<typeof WriteFileSchema>;

export interface WrittenFile {
  path: string;
  version: string;
  size: number;
}

export const CreateEntrySchema = z.strictObject({
  projectId: ProjectIdSchema,
  path: EntryPathSchema,
  kind: z.enum(['file', 'directory']),
});
export type CreateEntryInput = z.infer<typeof CreateEntrySchema>;

/** Renames or moves; fails with FILE_ALREADY_EXISTS instead of replacing `to`. */
export const MoveEntrySchema = z.strictObject({
  projectId: ProjectIdSchema,
  from: EntryPathSchema,
  to: EntryPathSchema,
});
export type MoveEntryInput = z.infer<typeof MoveEntrySchema>;

export const FileVersionsSchema = z.strictObject({
  projectId: ProjectIdSchema,
  paths: z.array(EntryPathSchema).max(FILE_VERSIONS_MAX),
});
export type FileVersionsInput = z.infer<typeof FileVersionsSchema>;

/** What is on disk now; `version` is null for missing, unreadable or too large files. */
export interface FileVersionInfo {
  path: string;
  exists: boolean;
  version: string | null;
}

export const FindFilesSchema = z.strictObject({
  projectId: ProjectIdSchema,
  query: z.string().trim().max(FILE_FIND_QUERY_MAX),
  limit: z.int().min(1).max(FILE_FIND_LIMIT_MAX).optional(),
});
export type FindFilesInput = z.infer<typeof FindFilesSchema>;

export interface FoundFiles {
  /** Best matches first. */
  paths: string[];
  /** The project has more files than were searched. */
  truncated: boolean;
}

/** Folders whose changes this client wants as `files` events; replaces the previous set. */
export const WatchFilesSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable(),
  directories: z.array(RelativeFilePathSchema).max(FILE_WATCH_MAX),
});
export type WatchFilesInput = z.infer<typeof WatchFilesSchema>;

// ---------------------------------------------------------------------------
// Editor preferences and layout (FR-1108, FR-1110)
// ---------------------------------------------------------------------------

export const EDITOR_THEMES = ['dark', 'light', 'high-contrast'] as const;
export const EDITOR_AUTO_SAVE = ['off', 'after-delay', 'on-focus-change'] as const;

const EditorPreferenceFields = {
  theme: z.enum(EDITOR_THEMES),
  /**
   * A color theme contributed by an extension (`<extension id>/<theme id>`, SDD-015
   * FR-1507). Used while that extension is enabled; otherwise `theme` applies.
   */
  colorTheme: z.string().min(3).max(400).nullable(),
  /** A file icon theme contributed by an extension (FR-1508); null keeps ATLAS icons. */
  iconTheme: z.string().min(3).max(400).nullable(),
  fontSize: z.int().min(8).max(32),
  tabSize: z.int().min(1).max(8),
  insertSpaces: z.boolean(),
  wordWrap: z.boolean(),
  minimap: z.boolean(),
  autoSave: z.enum(EDITOR_AUTO_SAVE),
  autoSaveDelayMs: z.int().min(200).max(60_000),
  /** Reload unmodified tabs when their file changes on disk (PLAN-033 Q5). */
  autoReload: z.boolean(),
  showHiddenFiles: z.boolean(),
  showIgnoredFiles: z.boolean(),
};

export const EditorPreferencesSchema = z.strictObject({
  theme: EditorPreferenceFields.theme.default('dark'),
  colorTheme: EditorPreferenceFields.colorTheme.default(null),
  iconTheme: EditorPreferenceFields.iconTheme.default(null),
  fontSize: EditorPreferenceFields.fontSize.default(13),
  tabSize: EditorPreferenceFields.tabSize.default(2),
  insertSpaces: EditorPreferenceFields.insertSpaces.default(true),
  wordWrap: EditorPreferenceFields.wordWrap.default(false),
  minimap: EditorPreferenceFields.minimap.default(true),
  autoSave: EditorPreferenceFields.autoSave.default('off'),
  autoSaveDelayMs: EditorPreferenceFields.autoSaveDelayMs.default(1000),
  autoReload: EditorPreferenceFields.autoReload.default(true),
  showHiddenFiles: EditorPreferenceFields.showHiddenFiles.default(true),
  showIgnoredFiles: EditorPreferenceFields.showIgnoredFiles.default(false),
});
export type EditorPreferences = z.output<typeof EditorPreferencesSchema>;

/**
 * Only the fields being changed. Built without defaults: with Zod 4, `.partial()` of the
 * schema above would fill every missing field with its default and reset it.
 */
export const UpdateEditorPreferencesSchema = z.strictObject(EditorPreferenceFields).partial();
export type UpdateEditorPreferencesInput = z.input<typeof UpdateEditorPreferencesSchema>;

const Percent = z.number().min(5).max(95);

export const EditorTabStateSchema = z.strictObject({
  path: EntryPathSchema,
  /** Cursor and scroll, restored when the tab opens. */
  line: z.int().min(1).max(10_000_000).optional(),
  column: z.int().min(1).max(100_000).optional(),
  scrollTop: z.number().min(0).max(1e9).optional(),
});
export type EditorTabState = z.infer<typeof EditorTabStateSchema>;

/** File references only: file contents are never stored (FR-1110). */
export const EditorLayoutSchema = z.strictObject({
  tabs: z.array(EditorTabStateSchema).max(EDITOR_LAYOUT_TABS_MAX),
  activePath: EntryPathSchema.nullable(),
  explorerVisible: z.boolean(),
  explorerSize: Percent,
  terminalVisible: z.boolean(),
  terminalSize: Percent,
  /** Folders expanded in the explorer. */
  expanded: z.array(EntryPathSchema).max(FILE_WATCH_MAX),
});
export type EditorLayout = z.infer<typeof EditorLayoutSchema>;
