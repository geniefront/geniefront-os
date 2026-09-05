import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard, Store, LifeBuoy, ShieldCheck, Globe, ScrollText, Inbox, LogOut,
} from 'lucide-react';
import { usePlatformSession } from '@/lib/session';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/stores', label: 'Stores', icon: Store },
  { to: '/support', label: 'Support', icon: LifeBuoy },
  { to: '/10dlc', label: '10DLC', icon: ShieldCheck },
  { to: '/website-requests', label: 'Website Requests', icon: Globe },
  { to: '/audit', label: 'Audit', icon: ScrollText },
  { to: '/email', label: 'Email & Domains', icon: Inbox },
  { to: '/test-inbox', label: 'Test Inbox', icon: Inbox },
];

export function Layout() {
  const { operator, signOut } = usePlatformSession();
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="flex border-b border-slate-800 bg-slate-950 text-slate-200 lg:min-h-screen lg:flex-col lg:border-b-0 lg:border-r">
        <div className="flex min-w-[220px] items-center gap-3 border-r border-slate-800 px-4 py-3 lg:block lg:border-b lg:border-r-0 lg:px-5 lg:py-5">
          <img src="/brand/geniefront-logo-on-dark.svg" alt="GenieFront" className="h-7 w-auto" />
          <div className="mt-3 hidden text-base font-semibold lg:block">Operations</div>
          <div className="mt-1 hidden truncate text-xs text-slate-400 lg:block">
            {operator?.email} · {operator?.role}
          </div>
        </div>
        <nav className="flex flex-1 gap-1 overflow-x-auto p-3 lg:flex-col lg:overflow-visible" aria-label="Operations">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? 'bg-teal-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden border-t border-slate-800 p-3 lg:block">
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0">
        <div className="ops-page mx-auto w-full max-w-[1500px] p-4 sm:p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
