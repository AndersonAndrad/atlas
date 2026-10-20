import { Icon } from './Icon';

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="empty-state" aria-labelledby="empty-title" data-testid="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        <Icon name="folder" size={28} />
      </div>
      <h2 id="empty-title">No projects yet</h2>
      <p>
        Register a local directory to start managing it with ATLAS. Your files stay where they are —
        ATLAS only keeps a reference.
      </p>
      <button type="button" className="button button--primary" onClick={onAdd}>
        <Icon name="plus" />
        Add project
      </button>
    </section>
  );
}
