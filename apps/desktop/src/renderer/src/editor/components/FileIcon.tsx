import type { FileEntryKind } from '@atlas/contracts';
import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSymlink,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';
import { iconIdFor, useIconImage, useIconTheme } from '@/extensions/runtime/icons';
import { cn } from '@/lib/utils';

const BY_EXTENSION: Record<string, [LucideIcon, string]> = {
  ts: [FileCode, 'text-sky-400'],
  tsx: [FileCode, 'text-sky-400'],
  mts: [FileCode, 'text-sky-400'],
  cts: [FileCode, 'text-sky-400'],
  js: [FileCode, 'text-yellow-400'],
  jsx: [FileCode, 'text-yellow-400'],
  mjs: [FileCode, 'text-yellow-400'],
  cjs: [FileCode, 'text-yellow-400'],
  py: [FileCode, 'text-emerald-400'],
  go: [FileCode, 'text-cyan-400'],
  rs: [FileCode, 'text-orange-400'],
  java: [FileCode, 'text-red-400'],
  kt: [FileCode, 'text-violet-400'],
  cs: [FileCode, 'text-violet-400'],
  css: [FileCode, 'text-blue-400'],
  scss: [FileCode, 'text-pink-400'],
  html: [FileCode, 'text-orange-400'],
  vue: [FileCode, 'text-emerald-400'],
  json: [FileJson, 'text-amber-300'],
  jsonc: [FileJson, 'text-amber-300'],
  yml: [FileCog, 'text-rose-300'],
  yaml: [FileCog, 'text-rose-300'],
  toml: [FileCog, 'text-rose-300'],
  ini: [FileCog, 'text-rose-300'],
  md: [FileText, 'text-slate-300'],
  mdx: [FileText, 'text-slate-300'],
  txt: [FileText, 'text-slate-300'],
  sh: [FileTerminal, 'text-lime-400'],
  zsh: [FileTerminal, 'text-lime-400'],
  bash: [FileTerminal, 'text-lime-400'],
  png: [FileImage, 'text-purple-300'],
  jpg: [FileImage, 'text-purple-300'],
  jpeg: [FileImage, 'text-purple-300'],
  gif: [FileImage, 'text-purple-300'],
  svg: [FileImage, 'text-purple-300'],
  webp: [FileImage, 'text-purple-300'],
  zip: [FileArchive, 'text-stone-400'],
  gz: [FileArchive, 'text-stone-400'],
  tgz: [FileArchive, 'text-stone-400'],
  lock: [FileLock, 'text-stone-400'],
};

const BY_NAME: Record<string, [LucideIcon, string]> = {
  'package.json': [FileJson, 'text-emerald-400'],
  'pnpm-lock.yaml': [FileLock, 'text-stone-400'],
  'package-lock.json': [FileLock, 'text-stone-400'],
  '.env': [FileLock, 'text-amber-400'],
  Dockerfile: [FileCog, 'text-sky-300'],
  Makefile: [FileTerminal, 'text-lime-400'],
};

/**
 * The icon of the file icon theme in use (SDD-015 FR-1508), or a generic icon per kind of
 * file when there is none or it has no image for this entry.
 */
export function FileIcon(props: {
  name: string;
  kind: FileEntryKind;
  open?: boolean;
  symlink?: boolean;
  className?: string;
}) {
  const { theme, revision } = useIconTheme();
  const iconId =
    theme === null ? null : iconIdFor(theme, props.name, props.kind, props.open ?? false);
  const image = useIconImage(theme?.key ?? null, revision, iconId);
  if (image !== null) {
    return (
      <img
        src={image}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('size-4 shrink-0', props.className)}
      />
    );
  }
  return <GenericFileIcon {...props} />;
}

/** A generic icon per kind of file. */
function GenericFileIcon({
  name,
  kind,
  open = false,
  symlink = false,
  className,
}: {
  name: string;
  kind: FileEntryKind;
  open?: boolean;
  symlink?: boolean;
  className?: string;
}) {
  let [Icon, color]: [LucideIcon, string] = [File, 'text-muted-foreground'];
  if (kind === 'directory') {
    [Icon, color] = [open ? FolderOpen : Folder, 'text-sky-300/80'];
  } else if (symlink) {
    [Icon, color] = [FileSymlink, 'text-muted-foreground'];
  } else {
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    [Icon, color] = BY_NAME[name] ??
      (name.startsWith('.env') ? BY_NAME['.env']! : null) ??
      BY_EXTENSION[extension] ?? [Icon, color];
  }
  return <Icon className={cn('size-4 shrink-0', color, className)} aria-hidden="true" />;
}
