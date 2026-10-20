import type { ShellCatalog } from '@atlas/contracts';
import { FolderOpen, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppInfo } from '@/hooks/useAppInfo';
import type { useTerminalPreferences } from '@/terminal/hooks/useTerminalPreferences';
import { GitSettingsSection } from '@/git/components/GitSettingsSection';
import { SessionSettingsSection } from '@/sessions/components/SessionSettingsSection';
import { AppInfoList } from './AppInfoList';

const SYSTEM_SHELL = '__system__';

interface SettingsViewProps {
  preferences: ReturnType<typeof useTerminalPreferences>;
}

export function SettingsView({ preferences }: SettingsViewProps) {
  const info = useAppInfo();
  const [shells, setShells] = useState<ShellCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = preferences.preferences;

  useEffect(() => {
    unwrap(api().terminals.shells()).then(setShells, () => setShells(null));
  }, []);

  async function chooseDefaultDirectory() {
    setError(null);
    try {
      const choice = await unwrap(api().dialog.chooseDirectory('default-directory'));
      if (choice.canceled || !choice.inspection) return;
      await preferences.update({ defaultWorkingDirectory: choice.inspection.inputPath });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b px-4">
        <h1 className="text-lg font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {(error ?? preferences.error) && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error ?? preferences.error}</AlertDescription>
            </Alert>
          )}

          <section
            className="bg-card flex flex-col gap-4 rounded-lg border p-4"
            aria-labelledby="terminal-settings-title"
          >
            <h2 id="terminal-settings-title" className="font-semibold">
              Terminals
            </h2>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium" id="default-dir-label">
                Default working directory
              </span>
              <p className="text-muted-foreground text-xs">
                Used by new terminals that are not opened in a project or a chosen folder.
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="bg-input/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs"
                  aria-labelledby="default-dir-label"
                  data-testid="default-directory"
                >
                  {current?.defaultWorkingDirectory ?? 'Home directory'}
                </span>
                <Button variant="outline" onClick={() => void chooseDefaultDirectory()}>
                  <FolderOpen />
                  Choose…
                </Button>
                {current?.defaultWorkingDirectory && (
                  <Button
                    variant="ghost"
                    onClick={() => void preferences.update({ defaultWorkingDirectory: null })}
                  >
                    <RotateCcw />
                    Use home
                  </Button>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium" id="default-shell-label">
                Default shell
              </span>
              <Select
                value={current?.defaultShellId ?? SYSTEM_SHELL}
                onValueChange={(value) =>
                  void preferences.update({ defaultShellId: value === SYSTEM_SHELL ? null : value })
                }
              >
                <SelectTrigger className="w-full sm:w-72" aria-labelledby="default-shell-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SYSTEM_SHELL}>System default</SelectItem>
                  {(shells?.shells ?? []).map((shell) => (
                    <SelectItem key={shell.id} value={shell.id}>
                      {shell.name} — {shell.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <GitSettingsSection />

          <SessionSettingsSection />

          <section
            className="bg-card flex flex-col gap-3 rounded-lg border p-4"
            aria-labelledby="about-title"
          >
            <h2 id="about-title" className="font-semibold">
              About ATLAS
            </h2>
            {info ? (
              <AppInfoList info={info} diagnostics />
            ) : (
              <p className="text-muted-foreground text-sm">Loading…</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
