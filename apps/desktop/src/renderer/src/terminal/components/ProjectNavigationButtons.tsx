import { PanelRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';

const isMac = navigator.userAgent.includes('Mac');
const keys = (mac: string, other: string) => (isMac ? mac : other);

interface ProjectNavigationButtonsProps {
  onSearch: () => void;
  onShowDrawer: () => void;
}

/** Buttons for the project palette and drawer; the same actions as their shortcuts (PLAN-052). */
export function ProjectNavigationButtons({
  onSearch,
  onShowDrawer,
}: ProjectNavigationButtonsProps) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Search projects"
        title={`Search projects (${keys('⌘P', 'Ctrl+Shift+P')})`}
        onClick={onSearch}
      >
        <Search />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Show projects panel"
        title={`Projects panel (${keys('⇧⌘P', 'Ctrl+Alt+Shift+P')})`}
        onClick={onShowDrawer}
      >
        <PanelRight />
      </Button>
    </>
  );
}
