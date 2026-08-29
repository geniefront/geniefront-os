import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { KioskHelloResponse } from '../types';
import { api, getStoredDeviceToken, setStoredDeviceToken } from '../api/client';

interface DeviceAuthContextValue {
  isPaired: boolean;
  deviceToken: string | null;
  storeInfo: KioskHelloResponse | null;
  isLoading: boolean;
  error: string | null;
  pairDevice: (code: string, label?: string) => Promise<void>;
  unpairDevice: () => void;
  refetchStoreInfo: () => Promise<void>;
  onResetHomeCommand?: (handler: () => void) => () => void;
}

const DeviceAuthContext = createContext<DeviceAuthContextValue | null>(null);

export const DeviceAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [deviceToken, setDeviceToken] = useState<string | null>(getStoredDeviceToken);
  const [storeInfo, setStoreInfo] = useState<KioskHelloResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const resetHomeListenersRef = useRef<Set<() => void>>(new Set());

  const unpairDevice = useCallback(() => {
    setStoredDeviceToken(null);
    setDeviceToken(null);
    setStoreInfo(null);
    setError(null);
  }, []);

  const loadStoreInfo = useCallback(async () => {
    const token = getStoredDeviceToken();
    if (!token) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await api.hello(() => {
        unpairDevice();
      });
      setStoreInfo(data);
    } catch (err: any) {
      if (err.status === 401) {
        unpairDevice();
      } else {
        setError(err.message || 'Failed to connect to kiosk backend');
      }
    } finally {
      setIsLoading(false);
    }
  }, [unpairDevice]);

  useEffect(() => {
    loadStoreInfo();
  }, [loadStoreInfo]);

  // ── 心跳轮询守护进程（每 30 秒上报并拉取远程短命令）─────────────────────
  useEffect(() => {
    if (!deviceToken) return;

    const runHeartbeat = async () => {
      try {
        let batteryLevel: number | undefined;
        if ('getBattery' in navigator) {
          try {
            const battery: any = await (navigator as any).getBattery();
            batteryLevel = Math.round(battery.level * 100);
          } catch {
            // Ignore
          }
        }

        const res = await api.heartbeat({
          model: navigator.userAgent.includes('iPad') ? 'iPad Kiosk Terminal' : navigator.userAgent.slice(0, 80),
          batteryLevel,
          appVersion: '2.5.0',
        });

        if (res.commands && res.commands.length > 0) {
          for (const cmd of res.commands) {
            if (cmd.kind === 'reset_home') {
              resetHomeListenersRef.current.forEach((fn) => fn());
            }
            await api.ackCommand(cmd.commandId, 'acknowledged');
          }
        }
      } catch (err: any) {
        if (err.status === 401) {
          unpairDevice();
        }
      }
    };

    const intervalId = setInterval(runHeartbeat, 30_000);
    // 首次启动时异步触碰一次
    runHeartbeat();

    return () => clearInterval(intervalId);
  }, [deviceToken, unpairDevice]);

  const pairDevice = useCallback(async (code: string, label?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const claim = await api.claimPairing(code, label);
      setStoredDeviceToken(claim.deviceToken);
      setDeviceToken(claim.deviceToken);
      const hello = await api.hello();
      setStoreInfo(hello);
    } catch (err: any) {
      setError(err.code || err.message || 'Pairing failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const onResetHomeCommand = useCallback((handler: () => void) => {
    resetHomeListenersRef.current.add(handler);
    return () => {
      resetHomeListenersRef.current.delete(handler);
    };
  }, []);

  return (
    <DeviceAuthContext.Provider
      value={{
        isPaired: Boolean(deviceToken && storeInfo),
        deviceToken,
        storeInfo,
        isLoading,
        error,
        pairDevice,
        unpairDevice,
        refetchStoreInfo: loadStoreInfo,
        onResetHomeCommand,
      }}
    >
      {children}
    </DeviceAuthContext.Provider>
  );
};

export function useDeviceAuth(): DeviceAuthContextValue {
  const ctx = useContext(DeviceAuthContext);
  if (!ctx) {
    throw new Error('useDeviceAuth must be used within a DeviceAuthProvider');
  }
  return ctx;
}
