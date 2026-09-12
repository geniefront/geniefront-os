import { useRef } from 'react';
import { platformSend } from './api';
import { usePlatformSession } from './session';

export function useIdempotentSend() {
  const attempts = useRef(new Map<string, string>());
  const { session } = usePlatformSession();
  return async (method: string, path: string, body: unknown) => {
    const intent = JSON.stringify([session?.user.id, method, path, body]);
    const key = attempts.current.get(intent) ?? crypto.randomUUID();
    attempts.current.set(intent, key);
    const result = await platformSend(method, path, body, key);
    attempts.current.delete(intent);
    return result;
  };
}
