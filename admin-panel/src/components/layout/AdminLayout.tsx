// ---------------------------------------------------------------------------
// Shell: collapsible sidebar + top bar (global search, identity, logout).
// ---------------------------------------------------------------------------
import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
  IconAudit,
  IconBook,
  IconClose,
  IconCommission,
  IconDashboard,
  IconGame,
  IconGift,
  IconLogout,
  IconMic,
  IconPartners,
  IconRecharge,
  IconSearch,
  IconSidebarToggle,
  IconUsers,
  IconWallet,
} from '../ui/Icons';
import { Avatar } from '../ui/Avatar';

const SIDEBAR_KEY = 'voiza.admin.sidebar.collapsed';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  /**
   * Navigation advice only. Hiding a link is not access control — the route guard in `App` and
   * `requirePermission` on the server each decide again, because a twelve-hour token can outlive
   * a role change and a hand-typed URL never consults this list at all.
   */
  permission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: <IconDashboard className="h-5 w-5" />, end: true, permission: 'dashboard:read' },
  { to: '/users', label: 'Users', icon: <IconUsers className="h-5 w-5" />, permission: 'user:read' },
  { to: '/rooms', label: 'Rooms', icon: <IconMic className="h-5 w-5" />, permission: 'room:read' },
  { to: '/gifts', label: 'Gifts', icon: <IconGift className="h-5 w-5" />, permission: 'dashboard:read' },
  { to: '/withdrawals', label: 'Withdrawals', icon: <IconWallet className="h-5 w-5" />, permission: 'withdrawal:review' },
  { to: '/games', label: 'Games', icon: <IconGame className="h-5 w-5" />, permission: 'game:read' },
  { to: '/partners', label: 'Partners', icon: <IconPartners className="h-5 w-5" />, permission: 'business:manage' },
  { to: '/recharges', label: 'Recharges', icon: <IconRecharge className="h-5 w-5" />, permission: 'finance:read' },
  { to: '/commissions', label: 'Commission', icon: <IconCommission className="h-5 w-5" />, permission: 'finance:read' },
  { to: '/finance', label: 'Finance book', icon: <IconBook className="h-5 w-5" />, permission: 'finance:read' },
  { to: '/audit', label: 'Audit', icon: <IconAudit className="h-5 w-5" />, permission: 'audit:read' },
];

export function AdminLayout() {
  const { admin, logout, can } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = search.trim();
    navigate(term.length > 0 ? `/users?q=${encodeURIComponent(term)}` : '/users');
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const displayName = admin?.displayName || admin?.username || 'Admin';
  const roleLabel = admin?.role ?? 'MODERATOR';

  const sidebar = (
    <div
      className={`flex h-full flex-col border-r border-edge/60 bg-surface transition-[width] duration-200 ${
        collapsed ? 'lg:w-[76px]' : 'lg:w-60'
      }`}
    >
      {/* brand */}
      <div className={`flex h-16 items-center gap-3 border-b border-edge/60 ${collapsed ? 'lg:justify-center lg:px-2' : 'px-4'}`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-gradient text-base font-black text-white shadow-glow-sm">
          V
        </span>
        <span className={`min-w-0 leading-tight ${collapsed ? 'lg:hidden' : ''}`}>
          <span className="block truncate text-sm font-bold text-ink">Voiza Admin</span>
          <span className="block truncate text-[10px] uppercase tracking-widest text-faint">Back office</span>
        </span>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="focus-ring ml-auto grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-ink lg:hidden"
          aria-label="Close navigation"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      {/* nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-3">
        {NAV_ITEMS.filter((item) => item.permission === undefined || can(item.permission)).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setMobileOpen(false)}
            title={item.label}
            className={({ isActive }) =>
              `focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                isActive
                  ? 'bg-brand-gradient-soft text-violet-200 shadow-glow-sm'
                  : 'text-muted hover:bg-elevated/70 hover:text-ink'
              } ${collapsed ? 'lg:justify-center lg:px-0' : ''}`
            }
          >
            {item.icon}
            <span className={collapsed ? 'lg:hidden' : ''}>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* collapse toggle */}
      <div className="border-t border-edge/60 p-2.5">
        <button
          type="button"
          onClick={toggleCollapsed}
          className={`focus-ring hidden w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-faint transition hover:bg-elevated/70 hover:text-ink lg:flex ${
            collapsed ? 'lg:justify-center lg:px-0' : ''
          }`}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <IconSidebarToggle className={`h-5 w-5 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          <span className={collapsed ? 'lg:hidden' : ''}>Collapse</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* desktop sidebar */}
      <aside className={`hidden lg:block ${collapsed ? 'w-[76px]' : 'w-60'} shrink-0 transition-[width] duration-200`}>
        {sidebar}
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/70 animate-fade-in" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 w-64 animate-slide-in-right">{sidebar}</div>
        </div>
      )}

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-edge/60 bg-base/80 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="focus-ring grid h-9 w-9 place-items-center rounded-lg border border-edge bg-surface text-muted hover:text-ink lg:hidden"
            aria-label="Open navigation"
          >
            <IconSidebarToggle className="h-5 w-5" />
          </button>

          <form onSubmit={submitSearch} className="relative hidden max-w-md flex-1 sm:block">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search users by phone or username…"
              className="focus-ring h-9 w-full rounded-lg border border-edge bg-elevated pl-9 pr-3 text-sm text-ink placeholder:text-faint"
              aria-label="Global user search"
            />
          </form>
          <span className="flex-1" />

          <div className="flex items-center gap-3">
            <div className="hidden text-right leading-tight md:block">
              <p className="max-w-40 truncate text-sm font-semibold text-ink">{displayName}</p>
              <p className="text-[10px] uppercase tracking-widest text-faint">{roleLabel}</p>
            </div>
            <Avatar name={displayName} size="sm" />
            <button
              type="button"
              onClick={handleLogout}
              className="focus-ring inline-flex h-9 items-center gap-2 rounded-lg border border-edge bg-surface px-3 text-sm text-muted transition hover:border-rose-500/50 hover:text-rose-300"
            >
              <IconLogout className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
