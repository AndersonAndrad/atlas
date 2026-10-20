import { FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center"
      aria-labelledby="empty-title"
      data-testid="empty-state"
    >
      <div
        className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full"
        aria-hidden="true"
      >
        <FolderOpen className="size-7" />
      </div>
      <h2 id="empty-title" className="text-lg font-semibold">
        No projects yet
      </h2>
      <p className="text-muted-foreground">
        Register a local directory to start managing it with ATLAS. Your files stay where they are —
        ATLAS only keeps a reference.
      </p>
      <Button onClick={onAdd}>
        <Plus />
        Add project
      </Button>
    </section>
  );
}
