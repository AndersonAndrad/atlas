import type { GitConfigValue, GitIdentityValues, ProjectGitIdentity } from '@atlas/contracts';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const failure = (caught: unknown) =>
  caught instanceof ApiError && caught.issues.length > 0
    ? caught.issues.map((issue) => issue.message).join(' ')
    : errorMessage(caught);

/** Git accepts addresses without "@", but hosting services rarely match them to accounts. */
function EmailWarning({ email }: { email: string }) {
  if (email.trim() === '' || email.includes('@')) return null;
  return (
    <p className="text-warning text-xs" data-testid="git-identity-email-warning">
      This email has no "@". Git accepts it, but hosting services may not link commits to an
      account.
    </p>
  );
}

const SCOPE_LABELS: Record<GitConfigValue['scope'], string> = {
  local: 'this repository',
  worktree: 'this worktree',
  global: 'global',
  system: 'system',
  command: 'command line',
  unknown: 'unknown',
};

function Source({ value, testId }: { value: GitConfigValue | null; testId: string }) {
  if (value === null) {
    return (
      <span className="text-muted-foreground text-xs" data-testid={testId}>
        Not configured
      </span>
    );
  }
  return (
    <span className="text-muted-foreground text-xs break-all" data-testid={testId}>
      {SCOPE_LABELS[value.scope]}
      {value.origin && ` · ${value.origin}`}
    </span>
  );
}

/**
 * Global `user.name` and `user.email` (SDD-024 Task 03). Saved only on explicit request;
 * applies to every repository that does not override it, also outside ATLAS.
 */
export function GlobalGitIdentitySection() {
  const id = useId();
  const [stored, setStored] = useState<GitIdentityValues | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.globalIdentity()).then(
      (value) => {
        if (cancelled) return;
        setStored(value);
        setName(value.name?.value ?? '');
        setEmail(value.email?.value ?? '');
      },
      (caught: unknown) => !cancelled && setError(failure(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setState('saving');
    setError(null);
    unwrap(api().git.setGlobalIdentity({ name, email })).then(
      (value) => {
        setStored(value);
        setName(value.name?.value ?? '');
        setEmail(value.email?.value ?? '');
        setState('saved');
      },
      (caught: unknown) => {
        setError(failure(caught));
        setState('idle');
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-3 border-t pt-4"
      onSubmit={save}
      aria-labelledby={`${id}-title`}
      data-testid="git-global-identity"
    >
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-sm font-medium">
          Git identity (global)
        </h3>
        <p className="text-muted-foreground text-xs">
          Author of new commits in every repository without its own identity, also outside ATLAS.
          Existing commits never change.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            autoComplete="name"
            onChange={(event) => {
              setName(event.target.value);
              setState('idle');
            }}
          />
          <Source value={stored?.name ?? null} testId="git-global-name-source" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input
            id={`${id}-email`}
            value={email}
            autoComplete="email"
            onChange={(event) => {
              setEmail(event.target.value);
              setState('idle');
            }}
          />
          <Source value={stored?.email ?? null} testId="git-global-email-source" />
          <EmailWarning email={email} />
        </div>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="git-identity-error">{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={state === 'saving' || stored === null}>
          {state === 'saving' ? 'Saving…' : 'Save global identity'}
        </Button>
        {state === 'saved' && (
          <span className="text-muted-foreground text-xs" role="status">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * The identity Git uses in a project's repository: effective values with their source,
 * whether they are inherited, and the repository's own overrides (SDD-024 Task 03).
 */
export function ProjectGitIdentitySection({ projectId }: { projectId: string }) {
  const id = useId();
  const [identity, setIdentity] = useState<ProjectGitIdentity | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (value: ProjectGitIdentity) => {
    setIdentity(value);
    setName(value.local.name ?? '');
    setEmail(value.local.email ?? '');
  };

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.projectIdentity(projectId)).then(
      (value) => !cancelled && show(value),
      (caught: unknown) => !cancelled && setError(failure(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const change = (input: { name?: string | null; email?: string | null }) => {
    setBusy(true);
    setSaved(false);
    setError(null);
    unwrap(api().git.setProjectIdentity(projectId, input))
      .then(
        (value) => {
          show(value);
          setSaved(true);
        },
        (caught: unknown) => setError(failure(caught)),
      )
      .finally(() => setBusy(false));
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    // Empty fields keep inheriting; only what was typed becomes an override.
    const input: { name?: string; email?: string } = {};
    if (name.trim() !== '' && name.trim() !== identity?.local.name) input.name = name;
    if (email.trim() !== '' && email.trim() !== identity?.local.email) input.email = email;
    if (Object.keys(input).length === 0) return;
    change(input);
  };

  const field = (
    key: 'name' | 'email',
    label: string,
    value: string,
    setValue: (value: string) => void,
  ) => {
    const effective = identity?.effective[key] ?? null;
    const overridden = identity?.local[key] != null;
    const overrides = identity?.environment.filter((item) => item.affects === key) ?? [];
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-${key}`}>{label}</Label>
          {identity && (
            <Badge
              variant={overridden ? 'secondary' : 'outline'}
              data-testid={`git-identity-${key}-mode`}
            >
              {overridden ? 'Overridden' : 'Inherited'}
            </Badge>
          )}
        </div>
        <p className="text-sm break-all" data-testid={`git-identity-${key}-effective`}>
          {effective?.value ?? <span className="text-muted-foreground">Not configured</span>}
        </p>
        <Source value={effective} testId={`git-identity-${key}-source`} />
        <Input
          id={`${id}-${key}`}
          value={value}
          placeholder={overridden ? undefined : 'Inherited — type to override'}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
        />
        {key === 'email' && <EmailWarning email={value} />}
        {overridden && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => change({ [key]: null })}
          >
            Use inherited {key}
          </Button>
        )}
        {overrides.map((item) => (
          <p key={item.variable} className="text-warning text-xs" data-testid="git-identity-env">
            Commits made in terminals use {item.variable}
            {item.value !== null && ` (${item.value})`} from your shell instead.
          </p>
        ))}
      </div>
    );
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={save}
      aria-labelledby={`${id}-title`}
      data-testid="git-project-identity"
    >
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="font-semibold">
          Git identity
        </h3>
        <p className="text-muted-foreground text-xs">
          As Git resolves it here (repository, includes, global, system). Overrides apply to the
          whole repository
          {identity && (
            <>
              {' '}
              <code className="break-all">{identity.repositoryRoot}</code>
            </>
          )}
          . Existing commits never change.
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="git-identity-error">{error}</AlertDescription>
        </Alert>
      )}
      {identity === null ? (
        !error && <p className="text-muted-foreground text-sm">Reading Git configuration…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {field('name', 'Name', name, setName)}
            {field('email', 'Email', email, setEmail)}
          </div>
          {identity.environment
            .filter((item) => item.affects === 'configuration')
            .map((item) => (
              <p
                key={item.variable}
                className="text-warning text-xs"
                data-testid="git-identity-env"
              >
                {item.variable} is set in your shell: terminals may read a different configuration.
              </p>
            ))}
          {!identity.environmentChecked && (
            <p className="text-muted-foreground text-xs">
              Your shell environment could not be checked for identity variables.
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" disabled={busy}>
              {busy ? 'Saving…' : 'Save repository identity'}
            </Button>
            {saved && (
              <span className="text-muted-foreground text-xs" role="status">
                Saved.
              </span>
            )}
          </div>
        </>
      )}
    </form>
  );
}
