import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

export function AuthLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center bg-[var(--gf-canvas)] p-4 pt-24 sm:p-8">
      <div className="absolute left-5 top-5 sm:left-8 sm:top-8">
        <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="h-9 w-auto sm:h-10" />
      </div>
      {children ?? <Outlet />}
    </div>
  );
}
