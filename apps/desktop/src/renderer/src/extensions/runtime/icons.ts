import type { ResolvedIconTheme } from '@atlas/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, unwrap } from '@/api';
import { extensionRuntime } from './runtime';

export { iconIdFor } from './icon-lookup';

const CACHE_MAX = 2000;
const images = new Map<string, Promise<string | null>>();

/**
 * The file icon theme in use (FR-1508), or null for ATLAS's own icons, with the revision
 * that keys its cached icons.
 */
export function useIconTheme(): { theme: ResolvedIconTheme | null; revision: string | null } {
  const snapshot = useSyncExternalStore(extensionRuntime.subscribe, extensionRuntime.getSnapshot);
  return { theme: snapshot.iconTheme, revision: snapshot.iconRevision };
}

function loadImage(theme: string, revision: string, iconId: string): Promise<string | null> {
  const key = `${theme}\n${revision}\n${iconId}`;
  let image = images.get(key);
  if (image === undefined) {
    if (images.size >= CACHE_MAX) images.clear();
    image = unwrap(api().extensions.icon({ theme, iconId })).catch(() => null);
    images.set(key, image);
  }
  return image;
}

/** The `data:` URI of an icon, once loaded; null while loading or when unavailable. */
export function useIconImage(
  theme: string | null,
  revision: string | null,
  iconId: string | null,
): string | null {
  const [loaded, setLoaded] = useState<{ key: string; image: string | null } | null>(null);
  const key = theme !== null && iconId !== null ? `${theme}\n${revision ?? ''}\n${iconId}` : null;
  useEffect(() => {
    if (theme === null || iconId === null) return;
    let cancelled = false;
    void (async () => {
      const image = await loadImage(theme, revision ?? '', iconId);
      if (!cancelled) setLoaded({ key: `${theme}\n${revision ?? ''}\n${iconId}`, image });
    })();
    return () => {
      cancelled = true;
    };
  }, [theme, revision, iconId]);
  return loaded !== null && loaded.key === key ? loaded.image : null;
}
