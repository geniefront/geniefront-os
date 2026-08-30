import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard, Store, LifeBuoy, ShieldCheck, Globe, ScrollText, LogOut,
} from 'lucide-react';
import { usePlatformSession } from '@/lib/session';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/stores', label: 'Stores', icon: Store },
  { to: '/support', label: 'Support', icon: LifeBuoy },
  { to: '/10dlc', label: '10DLC', icon: ShieldCheck },
  { to: '/website-requests', label: 'Website Requests', icon: Globe },
  { to: '/audit', label: 'Audit', icon: ScrollText },
];

export function Layout() {
  const { operator, signOut } = usePlatformSession();
  return (
    <div className="min-h-screen grid grid-cols-[240px_1fr]">
      <aside className="bg-slate-950 text-slate-200 flex flex-col">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="text-xs uppercase tracking-widest text-teal-400">GenieFront</div>
          <div className="font-semibold text-lg">Ops console</div>
          <div className="mt-2 text-xs text-slate-400 truncate">
            {operator?.email} · {operator?.role}
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  isActive ? 'bg-teal-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-800">
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
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-6 py-2">
          Internal operator console. Support Mode write impersonation is not enabled.
          Store pages are read-only except audited workflow actions.
        </div>
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
