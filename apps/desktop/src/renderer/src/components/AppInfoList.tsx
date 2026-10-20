import type { AppInfo } from '@atlas/contracts';

/** Definition list of version and environment details. */
export function AppInfoList({
  info,
  diagnostics = false,
}: {
  info: AppInfo;
  diagnostics?: boolean;
}) {
  const rows: [string, string][] = [
    ['Desktop version', info.desktopVersion],
    ['Engine version', info.engineVersion],
    ['Channel', info.channel === 'production' ? 'Production' : 'Development'],
    ['Build', info.buildId ?? 'Unknown'],
    ['Platform', `${info.platform} ${info.arch} (${info.osVersion})`],
  ];
  if (diagnostics) {
    rows.push(
      ['Electron', info.electronVersion],
      ['Chromium', info.chromeVersion],
      ['Node.js', info.nodeVersion],
      ['Database schema', String(info.schemaVersion)],
      ['Data directory', info.dataDir],
      ['Log file', info.logFile],
    );
  }
  return (
    <dl
      className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm"
      data-testid="app-info"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd
            className="font-mono text-xs break-all"
            data-testid={`app-info-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
