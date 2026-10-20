import { Icon, type IconName } from './Icon';

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  available: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'projects', label: 'Projects', icon: 'projects', available: true },
  { id: 'sessions', label: 'Sessions', icon: 'sessions', available: false },
  { id: 'agents', label: 'Agents', icon: 'agents', available: false },
  { id: 'skills', label: 'Skills', icon: 'skills', available: false },
  { id: 'accounts', label: 'Accounts', icon: 'accounts', available: false },
  { id: 'usage', label: 'Usage', icon: 'usage', available: false },
  { id: 'settings', label: 'Settings', icon: 'settings', available: false },
];

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="sidebar__brand" aria-label="ATLAS">
        <span className="sidebar__logo" aria-hidden="true">
          A
        </span>
        <span className="sidebar__brand-name">ATLAS</span>
      </div>
      <ul className="sidebar__list">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            {item.available ? (
              <button type="button" className="nav-item nav-item--active" aria-current="page">
                <Icon name={item.icon} />
                <span className="nav-item__label">{item.label}</span>
              </button>
            ) : (
              <button
                type="button"
                className="nav-item"
                disabled
                title={`${item.label} — not available yet`}
                aria-label={`${item.label} (not available yet)`}
              >
                <Icon name={item.icon} />
                <span className="nav-item__label">{item.label}</span>
                <span className="nav-item__soon">Soon</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
