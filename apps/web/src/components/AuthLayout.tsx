import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { Sparkles } from 'lucide-react';

export function AuthLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="min-h-screen w-full bg-slate-50 flex flex-col items-center justify-center p-4 relative">
      <div className="absolute top-8 left-8 flex items-center gap-3">
        <div className="w-10 h-10 bg-teal-600 rounded-xl flex items-center justify-center text-white shadow-md">
          <Sparkles className="w-5 h-5" />
        </div>
        <span className="font-bold text-2xl tracking-tight text-slate-800">GenieFront</span>
      </div>
      {children ?? <Outlet />}
    </div>
  );
}
