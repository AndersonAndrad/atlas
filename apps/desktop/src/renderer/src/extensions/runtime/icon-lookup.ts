import type { ResolvedIconTheme } from '@atlas/contracts';

/** VS Code's lookup: file name, then the longest matching extension, then the default. */
export function iconIdFor(
  theme: ResolvedIconTheme,
  name: string,
  kind: 'file' | 'directory' | string,
  open: boolean,
): string | null {
  const lower = name.toLowerCase();
  if (kind === 'directory') {
    if (open) {
      return theme.folderNamesExpanded[lower] ?? theme.folderExpanded ?? theme.folder;
    }
    return theme.folderNames[lower] ?? theme.folder;
  }
  const byName = theme.fileNames[lower];
  if (byName !== undefined) return byName;
  const parts = lower.split('.');
  for (let index = 1; index < parts.length; index += 1) {
    const extension = parts.slice(index).join('.');
    const id = theme.fileExtensions[extension];
    if (id !== undefined) return id;
  }
  return theme.file;
}
