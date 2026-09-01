import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

export function AuthLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="min-h-screen w-full bg-slate-50 flex flex-col items-center justify-center p-4 relative">
      <div className="absolute top-8 left-8">
        <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="h-11 w-auto" />
      </div>
      {children ?? <Outlet />}
    </div>
  );
}
