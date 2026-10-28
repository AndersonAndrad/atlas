import {
  HOSTING_ACCOUNT_LABEL_MAX,
  HOSTING_TOKEN_MAX,
  type HostingAccount,
  type HostingProvider,
} from '@atlas/contracts';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PROVIDER_LABELS, TOKEN_HELP, parseAliases } from '../format';

type Field = 'label' | 'email' | 'sshAliases' | 'token';
type FieldErrors = Partial<Record<Field, string>>;

function toFieldErrors(issues: { field: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.field
      .split('.')
      .find((part) => ['label', 'email', 'sshAliases', 'token'].includes(part)) as
      Field | undefined;
    if (field !== undefined && errors[field] === undefined) errors[field] = issue.message;
  }
  return errors;
}

export type AccountDialogMode =
  | { kind: 'add' }
  | { kind: 'edit'; account: HostingAccount }
  | { kind: 'token'; account: HostingAccount };

/**
 * Adds a hosting account, edits its details or replaces its token (SDD-024 Task 04). The
 * token is sent once to the main process, which encrypts it; the field is cleared after.
 */
export function AccountDialog({
  mode,
  storeAvailable,
  onClose,
  onSaved,
}: {
  mode: AccountDialogMode;
  storeAvailable: boolean;
  onClose: () => void;
  onSaved: (account: HostingAccount) => void;
}) {
  const existing = mode.kind === 'add' ? null : mode.account;
  const [provider, setProvider] = useState<HostingProvider>(existing?.provider ?? 'GITHUB');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [aliases, setAliases] = useState(existing?.sshAliases.join(', ') ?? '');
  const [token, setToken] = useState('');
  // An account created by this dialog whose token was not saved yet: retrying only saves it.
  const [created, setCreated] = useState<HostingAccount | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showDetails = mode.kind !== 'token' && created === null;
  const showToken = mode.kind !== 'edit';

  async function save() {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      let account = created ?? existing;
      if (mode.kind === 'add' && created === null) {
        if (token === '') {
          setErrors({ token: 'Paste the token.' });
          return;
        }
        account = await unwrap(
          api().hosting.createAccount({
            provider,
            label,
            email: provider === 'BITBUCKET' ? email : null,
            sshAliases: parseAliases(aliases),
          }),
        );
        setCreated(account);
      } else if (mode.kind === 'edit') {
        account = await unwrap(
          api().hosting.updateAccount({
            accountId: mode.account.id,
            label,
            ...(mode.account.provider === 'BITBUCKET' ? { email } : {}),
            sshAliases: parseAliases(aliases),
          }),
        );
      }
      if (showToken) {
        account = await unwrap(api().hosting.saveCredential({ accountId: account!.id, token }));
        setToken('');
      }
      onSaved(account!);
    } catch (caught) {
      const found = caught instanceof ApiError ? toFieldErrors(caught.issues) : {};
      setErrors(found);
      if (Object.keys(found).length === 0) setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode.kind === 'add'
      ? 'Add hosting account'
      : mode.kind === 'edit'
        ? `Edit ${mode.account.label}`
        : `Replace the token of ${mode.account.label}`;
  const fieldError = (field: Field) =>
    errors[field] && (
      <p id={`hosting-${field}-error`} className="text-destructive text-xs">
        {errors[field]}
      </p>
    );
  const invalid = (field: Field) =>
    errors[field] ? { 'aria-invalid': true, 'aria-describedby': `hosting-${field}-error` } : {};

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent data-testid="hosting-account-dialog">
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              ATLAS only reads from the provider. The token is encrypted by your system&apos;s
              secret store and never shown again.
            </DialogDescription>
          </DialogHeader>
          {created !== null && (
            <Alert role="status">
              <AlertDescription>
                The account was added. Save its token to connect it.
              </AlertDescription>
            </Alert>
          )}
          {showDetails && (
            <>
              {mode.kind === 'add' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="hosting-provider">Provider</Label>
                  <Select
                    value={provider}
                    onValueChange={(value) => setProvider(value as HostingProvider)}
                  >
                    <SelectTrigger id="hosting-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GITHUB">GitHub</SelectItem>
                      <SelectItem value="BITBUCKET">Bitbucket Cloud</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="hosting-label">Name</Label>
                <Input
                  id="hosting-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={HOSTING_ACCOUNT_LABEL_MAX}
                  placeholder="Work"
                  autoFocus
                  {...invalid('label')}
                />
                {fieldError('label')}
              </div>
              {provider === 'BITBUCKET' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="hosting-email">Atlassian account email</Label>
                  <Input
                    id="hosting-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    maxLength={254}
                    autoComplete="off"
                    {...invalid('email')}
                  />
                  {fieldError('email')}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="hosting-aliases">SSH aliases (optional)</Label>
                <Input
                  id="hosting-aliases"
                  value={aliases}
                  onChange={(event) => setAliases(event.target.value)}
                  placeholder="github-work, gh-personal"
                  autoComplete="off"
                  aria-describedby="hosting-aliases-help"
                  {...invalid('sshAliases')}
                />
                <p id="hosting-aliases-help" className="text-muted-foreground text-xs">
                  Host aliases from ~/.ssh/config whose repositories belong to this account.
                </p>
                {fieldError('sshAliases')}
              </div>
            </>
          )}
          {showToken && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hosting-token">
                {(existing ?? created)?.provider === 'BITBUCKET' || provider === 'BITBUCKET'
                  ? 'API token'
                  : 'Personal access token'}
              </Label>
              <Input
                id="hosting-token"
                type="password"
                className="font-mono"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                maxLength={HOSTING_TOKEN_MAX}
                autoComplete="off"
                spellCheck={false}
                disabled={!storeAvailable}
                autoFocus={mode.kind === 'token'}
                aria-describedby="hosting-token-help"
                {...invalid('token')}
              />
              <p id="hosting-token-help" className="text-muted-foreground text-xs">
                {TOKEN_HELP[(existing ?? created)?.provider ?? provider]}
              </p>
              {fieldError('token')}
            </div>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {created !== null ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={busy || (showToken && !storeAvailable)}>
              {busy
                ? 'Saving…'
                : mode.kind === 'edit'
                  ? 'Save'
                  : `Save and test${mode.kind === 'add' ? ` ${PROVIDER_LABELS[provider]}` : ''}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
