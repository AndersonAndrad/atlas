/**
 * Small dot on a button telling that something is waiting (e.g. changes to commit).
 * The reasons belong in the button's `title`, which keeps its accessible name stable.
 */
export function ActionDot({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <span
      className="bg-warning ring-background pointer-events-none absolute -top-1 -right-1 size-2.5 rounded-full ring-2"
      aria-hidden="true"
      data-testid="git-action-dot"
    />
  );
}
