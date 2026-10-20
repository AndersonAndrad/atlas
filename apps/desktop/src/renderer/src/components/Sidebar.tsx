import {
  Bot,
  ChartColumn,
  FolderGit2,
  GitBranch,
  KeyRound,
  ListChecks,
  Settings,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import atlasLogo from '@/assets/atlas-logo.svg';
import { cn } from '@/lib/utils';

export type AppView = 'projects' | 'terminals' | 'git' | 'sessions' | 'settings';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  view?: AppView;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'projects', label: 'Projects', icon: FolderGit2, view: 'projects' },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal, view: 'terminals' },
  { id: 'git', label: 'Git', icon: GitBranch, view: 'git' },
  { id: 'sessions', label: 'Sessions', icon: ListChecks, view: 'sessions' },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'accounts', label: 'Accounts', icon: KeyRound },
  { id: 'usage', label: 'Usage', icon: ChartColumn },
  { id: 'settings', label: 'Settings', icon: Settings, view: 'settings' },
];

interface SidebarProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
  /** e.g. "v0.4.0-dev"; comes from the build, never hardcoded. */
  version: string | null;
  onAbout: () => void;
}

export function Sidebar({ view, onNavigate, version, onAbout }: SidebarProps) {
  return (
    <nav
      className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-14 shrink-0 flex-col border-r lg:w-48"
      aria-label="Main navigation"
    >
      <div className="flex h-12 items-center gap-2 px-3" aria-label="ATLAS">
        {/* The artwork is 2:1 with empty margins; cover keeps its centered mark. */}
        <img
          src={atlasLogo}
          alt=""
          className="size-8 shrink-0 object-cover"
          data-testid="atlas-logo"
          draggable={false}
        />
        <span className="hidden font-semibold tracking-wide lg:inline">ATLAS</span>
      </div>
      <ul className="flex flex-col gap-0.5 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.view !== undefined && item.view === view;
          return (
            <li key={item.id}>
              {item.view !== undefined ? (
                <button
                  type="button"
                  className={cn(
                    'hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left outline-none focus-visible:ring-2',
                    active && 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                  )}
                  aria-current={active ? 'page' : undefined}
                  title={item.label}
                  onClick={() => onNavigate(item.view!)}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="hidden truncate lg:inline">{item.label}</span>
                  <span className="sr-only lg:hidden">{item.label}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground flex h-9 w-full cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 text-left opacity-60"
                  disabled
                  title={`${item.label} — not available yet`}
                  aria-label={`${item.label} (not available yet)`}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="hidden truncate lg:inline">{item.label}</span>
                  <span className="ml-auto hidden text-[10px] tracking-wide uppercase lg:inline">
                    Soon
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {version && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-auto px-3 py-2 text-left text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={onAbout}
          title="About ATLAS"
          data-testid="sidebar-version"
        >
          <span className="hidden lg:inline">ATLAS </span>
          {version}
        </button>
      )}
    </nav>
  );
}
