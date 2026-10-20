import type { AppInfo } from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { api, unwrap } from '@/api';

/** Version and environment details from the main process (never hardcoded in the UI). */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    unwrap(api().app.info()).then(setInfo, () => setInfo(null));
  }, []);
  return info;
}

export function versionLabel(info: AppInfo): string {
  return `v${info.desktopVersion}${info.channel === 'development' ? '-dev' : ''}`;
}
