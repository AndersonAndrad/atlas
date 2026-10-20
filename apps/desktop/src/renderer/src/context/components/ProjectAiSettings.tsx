import type { LlmWrapperStatus, ProjectConfigView, UpdateProjectAiConfig } from '@atlas/contracts';
import { Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { copyText } from '@/lib/clipboard';
import { formatDateTime } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

const WRAPPER_LABELS: Record<LlmWrapperStatus, string> = {
  wrapped: 'Reads the ATLAS configuration',
  shadowed: 'Another copy comes first on PATH: the ATLAS configuration is not passed',
  missing: 'Not installed',
  unknown: 'Could not be checked',
};

const WRAPPER_TONES: Record<LlmWrapperStatus, string> = {
  wrapped: 'text-success',
  shadowed: 'text-warning',
  missing: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
};

/**
 * AI options of a project (PLAN-014), stored as JSON in the ATLAS data directory, never in
 * the project. Claude Code and Codex started in the project's ATLAS terminals are told to
 * read that file first and, when context is kept, the project's shared context file.
 */
export function ProjectAiSettings({ projectId }: { projectId: string }) {
  const id = useId();
  const loaded = useKeyedLoad(projectId, () => api().context.projectConfig(projectId));
  const [updated, setUpdated] = useState<{ key: string; view: ProjectConfigView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const view = updated?.key === projectId ? updated.view : loaded.value;

  async function change(changes: UpdateProjectAiConfig) {
    setBusy(true);
    setError(null);
    try {
      const next = await unwrap(api().context.setProjectConfig(projectId, changes));
      setUpdated({ key: projectId, view: next });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copy(path: string) {
    try {
      await copyText(path);
      setCopied(path);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (view === null) {
    return loaded.error ? (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{loaded.error}</AlertDescription>
      </Alert>
    ) : (
      <p className="text-muted-foreground text-sm">Loading…</p>
    );
  }

  const { config } = view;
  const files = [
    { label: 'Configuration file', path: view.configPath },
    ...(config.keepContext ? [{ label: 'Context file', path: config.context.file }] : []),
  ];

  return (
    <div className="flex flex-col gap-3" data-testid="project-ai-settings">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-keep`}
          checked={config.keepContext}
          disabled={busy}
          onCheckedChange={(checked) => void change({ keepContext: checked === true })}
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${id}-keep`}>Keep shared context</Label>
          <span className="text-muted-foreground text-xs">
            LLMs started in this project’s ATLAS terminals read what earlier sessions recorded: work
            done, tests, decisions and what is pending. They only read it.
          </span>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-enabled`}
          checked={config.atlasEnabled}
          disabled={busy}
          onCheckedChange={(checked) => void change({ atlasEnabled: checked === true })}
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${id}-enabled`}>Enable ATLAS</Label>
          <span className="text-muted-foreground text-xs">
            Recorded in the project configuration for upcoming ATLAS features.
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {files.map((file) => (
          <div key={file.label} className="contents">
            <dt className="text-muted-foreground">{file.label}</dt>
            <dd className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 font-mono text-xs break-all">{file.path}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`Copy ${file.label.toLowerCase()} path`}
                title={copied === file.path ? 'Copied' : 'Copy path'}
                onClick={() => void copy(file.path)}
              >
                <Copy className="size-3.5" />
              </Button>
            </dd>
          </div>
        ))}
        {config.keepContext && (
          <>
            <dt className="text-muted-foreground">Context updated</dt>
            <dd data-testid="context-file-updated">{formatDateTime(config.context.updatedAt)}</dd>
          </>
        )}
        {(['claude', 'codex'] as const).map((cli) => (
          <div key={cli} className="contents">
            <dt className="text-muted-foreground">{cli === 'claude' ? 'Claude Code' : 'Codex'}</dt>
            <dd className={WRAPPER_TONES[view.wrappers[cli]]} data-testid={`wrapper-${cli}`}>
              {WRAPPER_LABELS[view.wrappers[cli]]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
