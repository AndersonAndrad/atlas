import type {
  CreateHttpCollectionInput,
  HttpCollection,
  HttpCollectionScope,
} from '@atlas/contracts';
import { useState } from 'react';
import { ApiError, errorMessage } from '@/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import type { ProjectDetails } from '@/types';

/** Runs `action`, showing a field message or a general error in the dialog. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

type ScopeKind = HttpCollectionScope['kind'];

interface CollectionDialogProps {
  open: boolean;
  /** Editing this collection; creating a new one when null. */
  collection: HttpCollection | null;
  projects: ProjectDetails[];
  /** The project in view, offered as the default owner. */
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateHttpCollectionInput) => Promise<void>;
}

/** Name, description and who sees a collection (FR-1416, FR-1417). */
export function CollectionDialog(props: CollectionDialogProps) {
  return props.open ? <CollectionForm {...props} /> : null;
}

function CollectionForm({
  open,
  collection,
  projects,
  projectId,
  onOpenChange,
  onSubmit,
}: CollectionDialogProps) {
  const initialScope = collection?.scope;
  const [name, setName] = useState(collection?.name ?? '');
  const [description, setDescription] = useState(collection?.description ?? '');
  const [kind, setKind] = useState<ScopeKind>(
    initialScope?.kind ?? (projectId ? 'project' : 'global'),
  );
  const [owner, setOwner] = useState<string | null>(
    initialScope?.kind === 'project' ? initialScope.projectId : projectId,
  );
  const [shared, setShared] = useState<string[]>(
    initialScope?.kind === 'shared' ? initialScope.projectIds : projectId ? [projectId] : [],
  );
  const { busy, error, submit } = useSubmit();
  const scope = (): HttpCollectionScope | null => {
    if (kind === 'global') return { kind };
    if (kind === 'project') return owner ? { kind, projectId: owner } : null;
    return shared.length > 0 ? { kind, projectIds: shared } : null;
  };
  const valid = name.trim() !== '' && scope() !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="collection-dialog">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const chosen = scope();
            if (!valid || chosen === null) return;
            void submit(async () => {
              await onSubmit({ name: name.trim(), description, scope: chosen });
              onOpenChange(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{collection ? 'Edit collection' : 'New collection'}</DialogTitle>
            <DialogDescription>
              Collections are stored on this computer. A project collection appears only with its
              project.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-name">Name</Label>
            <Input
              id="collection-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-description">Description (optional)</Label>
            <Textarea
              id="collection-description"
              value={description}
              maxLength={2000}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-scope">Available in</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as ScopeKind)}>
              <SelectTrigger id="collection-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Every project</SelectItem>
                <SelectItem value="project" disabled={projects.length === 0}>
                  One project
                </SelectItem>
                <SelectItem value="shared" disabled={projects.length === 0}>
                  Selected projects
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === 'project' && (
            <Select value={owner ?? undefined} onValueChange={setOwner}>
              <SelectTrigger className="w-full" aria-label="Project">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map(({ project }) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {kind === 'shared' && (
            <fieldset className="flex max-h-40 flex-col gap-1.5 overflow-auto rounded-md border p-2">
              <legend className="sr-only">Projects</legend>
              {projects.map(({ project }) => (
                <label key={project.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={shared.includes(project.id)}
                    onCheckedChange={(checked) =>
                      setShared((current) =>
                        checked === true
                          ? [...current, project.id]
                          : current.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.name}
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {collection ? 'Save' : 'Create collection'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface NameDialogProps {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initial: string;
  submitLabel: string;
  testId: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => Promise<void>;
  /** Shown above the name, e.g. a warning. */
  children?: React.ReactNode;
}

/** One name to enter: a folder, a rename, a saved response. */
export function NameDialog(props: NameDialogProps) {
  return props.open ? <NameForm {...props} /> : null;
}

function NameForm({
  open,
  title,
  description,
  label,
  initial,
  submitLabel,
  testId,
  onOpenChange,
  onSubmit,
  children,
}: NameDialogProps) {
  const [name, setName] = useState(initial);
  const { busy, error, submit } = useSubmit();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={testId}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '') return;
            void submit(async () => {
              await onSubmit(name.trim());
              onOpenChange(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${testId}-name`}>{label}</Label>
            <Input
              id={`${testId}-name`}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim() === '' || busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Every folder of a collection as "A / B", for choosing where a request goes. */
export function folderPaths(collection: HttpCollection): { id: string; path: string }[] {
  const byId = new Map(collection.folders.map((folder) => [folder.id, folder]));
  const pathOf = (id: string): string => {
    const folder = byId.get(id)!;
    return folder.parentId && byId.has(folder.parentId)
      ? `${pathOf(folder.parentId)} / ${folder.name}`
      : folder.name;
  };
  return collection.folders
    .map((folder) => ({ id: folder.id, path: pathOf(folder.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const ROOT = '__root__';

interface SaveRequestDialogProps {
  open: boolean;
  /** `move` keeps the name and only chooses another place (FR-1406). */
  mode: 'save' | 'move';
  collections: HttpCollection[];
  initial: { name: string; collectionId: string | null; folderId: string | null };
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: {
    name: string;
    collectionId: string;
    folderId: string | null;
  }) => Promise<void>;
  onCreateCollection: () => void;
}

/** Where a new request is saved, or a copy of it (FR-1406). */
export function SaveRequestDialog(props: SaveRequestDialogProps) {
  return props.open ? <SaveRequestForm {...props} /> : null;
}

function SaveRequestForm({
  open,
  mode,
  collections,
  initial,
  onOpenChange,
  onSubmit,
  onCreateCollection,
}: SaveRequestDialogProps) {
  const [name, setName] = useState(initial.name);
  const [collectionId, setCollectionId] = useState(
    initial.collectionId ?? collections[0]?.id ?? null,
  );
  const [folderId, setFolderId] = useState<string | null>(initial.folderId);
  const { busy, error, submit } = useSubmit();
  const collection = collections.find((candidate) => candidate.id === collectionId) ?? null;
  const folders = collection ? folderPaths(collection) : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="save-request-dialog">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (collectionId === null || name.trim() === '') return;
            void submit(async () => {
              await onSubmit({ name: name.trim(), collectionId, folderId });
              onOpenChange(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === 'move' ? `Move ${initial.name}` : 'Save request'}</DialogTitle>
            <DialogDescription>
              {mode === 'move'
                ? 'Choose the collection and folder of this request.'
                : 'Secret values are not saved: enter them again after ATLAS restarts.'}
            </DialogDescription>
          </DialogHeader>
          {mode === 'save' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="save-request-name">Name</Label>
              <Input
                id="save-request-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
          )}
          {collections.length === 0 ? (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p className="text-muted-foreground">Create a collection to save requests in.</p>
              <Button type="button" size="sm" variant="outline" onClick={onCreateCollection}>
                New collection
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="save-request-collection">Collection</Label>
                <Select
                  value={collectionId ?? undefined}
                  onValueChange={(value) => {
                    setCollectionId(value);
                    setFolderId(null);
                  }}
                >
                  <SelectTrigger id="save-request-collection" className="w-full">
                    <SelectValue placeholder="Choose a collection" />
                  </SelectTrigger>
                  <SelectContent>
                    {collections.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="save-request-folder">Folder</Label>
                <Select
                  value={folderId ?? ROOT}
                  onValueChange={(value) => setFolderId(value === ROOT ? null : value)}
                >
                  <SelectTrigger id="save-request-folder" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROOT}>No folder</SelectItem>
                    {folders.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {folder.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={collectionId === null || name.trim() === '' || busy}>
              {mode === 'move' ? 'Move' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface Confirmation {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => Promise<void> | void;
}

/** Asks before something that cannot be undone. */
export function ConfirmDialog({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent data-testid="workbench-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-white"
            onClick={() => {
              void confirmation?.run();
              onClose();
            }}
          >
            {confirmation?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
