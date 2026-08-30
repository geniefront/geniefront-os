import { usePlatformSession } from '@/lib/session';

export function AccessDenied() {
  const { signOut, session } = usePlatformSession();
  return (
    <div className="min-h-screen grid place-items-center bg-slate-50">
      <div className="max-w-md bg-white border border-slate-200 rounded-2xl p-6 space-y-3">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-sm text-slate-600">
          {session?.user.email} is signed in, but is not a GenieFront operator.
          Store owner and manager roles do not grant platform access.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
