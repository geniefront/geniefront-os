/**
 * 会话上下文：登录状态、门店归属、网络可用性。
 *
 * 设计约束：
 *
 * 1. **门店归属是服务端事实，不是本地偏好。** `membershipId` 必须来自
 *    `/v1/me/locations` 返回的集合；localStorage 中的记录仅用于在多店场景下
 *    还原上次选择，且每次登录都会与服务端返回的集合做交叉校验。
 *    校验不通过（离职、门店停用、换设备）时静默丢弃并重新进入选择流程。
 *
 * 2. **权限判断不在前端。** `roleKeys` 仅用于界面呈现（例如隐藏无关入口），
 *    真正的授权由服务端在命令总线上完成。前端不得据此放行任何写操作。
 *
 * 3. **离线是一等状态。** 实体门店的网络中断是常态。断网时界面降级为只读，
 *    不阻断、不跳转、不清空已渲染的数据（参见 `lib/offline.ts`）。
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useQueryClient } from '@tanstack/react-query';
import { clearCache, watchNetwork } from './offline';
import {
  fetchMembershipContext, fetchLocationsAndClaimable, setActiveMembershipId, setUnauthenticatedHandler,
  setCommandGuard, claimLocation, API_BASE,
  type LocationMembership, type MembershipContext, type ClaimableStore,
} from './api';

const ACTIVE_MEMBERSHIP_KEY = 'gf.membershipId';
const ACTIVE_PORTAL_KEY = 'gf.activePortal';

export type PortalType = 'admin' | 'tech';

/** 会话生命周期。界面据此决定渲染登录页、选店页还是主应用。 */
export type SessionStatus =
  | 'loading'        // 正在还原 Supabase 会话或拉取门店列表
  | 'unauthenticated'// 未登录
  | 'error'          // 门店列表拉取失败（网络或服务端故障），可重试
  | 'selecting'      // 已登录，存在多个门店身份，等待选择
  | 'portal-selecting' // 已登录且选定门店，具备双重身份（管理+技师），等待选择工作台
  | 'no-membership'  // 已登录但确认无任何有效门店身份（离职或尚未认领门店）
  | 'ready';         // 已登录、已确定门店、且操作上下文已就绪

interface SessionContextValue {
  status: SessionStatus;
  session: Session | null;
  locations: LocationMembership[];
  membership: LocationMembership | null;
  /** 当前用户是否存在待认领开通的已付费门店（例如刚在 Stripe 付款成功） */
  claimable: ClaimableStore | null;
  /** 当前门店的操作上下文（权限、时区、语言）。门店未就绪时为 null。 */
  context: MembershipContext | null;
  /**
   * 权限判定。**所有按钮的显隐与禁用都必须经由此函数**，不得依据角色。
   * 上下文尚未就绪时一律返回 false —— 宁可短暂少画一个按钮，
   * 也不要画出一个点下去 403 的按钮。
   */
  can: (permission: string) => boolean;
  /** 当前门店的 membership id。未就绪时为 null，请求层据此拒绝发出带店请求。 */
  membershipId: string | null;
  isOnline: boolean;
  /** 门店列表加载失败时的错误信息，用于在选店页给出可重试的提示。 */
  loadError: string | null;
  /** 当前工作台模式：'admin' = 后台管理, 'tech' = 技师工作台 */
  activePortal: PortalType;
  portalPreference: PortalType | null;
  isTechCapable: boolean;
  isPureTech: boolean;
  isManagementCapable: boolean;
  isDualRole: boolean;
  setPortal: (portal: PortalType) => void;
  switchPortal: () => void;
  selectMembership: (membershipId: string, portal?: PortalType) => void;
  /** 认领当前待开通门店并自动刷新门店列表 */
  claimStore: () => Promise<void>;
  /** 返回选店页。多店用户在顶栏切店时调用。 */
  clearMembership: () => void;
  reloadLocations: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

function readStoredPortal(): PortalType | null {
  try {
    const p = localStorage.getItem(ACTIVE_PORTAL_KEY);
    return p === 'admin' || p === 'tech' ? p : null;
  } catch {
    return null;
  }
}

function writeStoredPortal(value: PortalType | null): void {
  try {
    if (value === null) localStorage.removeItem(ACTIVE_PORTAL_KEY);
    else localStorage.setItem(ACTIVE_PORTAL_KEY, value);
  } catch {
    // 忽略存储异常
  }
}

function readStoredMembershipId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_MEMBERSHIP_KEY);
  } catch {
    // 隐私模式下 localStorage 访问可能抛出异常，退化为不记忆选择。
    return null;
  }
}

function writeStoredMembershipId(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(ACTIVE_MEMBERSHIP_KEY);
    else localStorage.setItem(ACTIVE_MEMBERSHIP_KEY, value);
  } catch {
    // 同上：存储不可用时不影响本次会话的正常使用。
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [locations, setLocations] = useState<LocationMembership[]>([]);
  const [claimable, setClaimable] = useState<ClaimableStore | null>(null);
  const [locationsLoaded, setLocationsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [membershipId, setMembershipId] = useState<string | null>(readStoredMembershipId);
  const [context, setContext] = useState<MembershipContext | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  // ── Supabase 会话 ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    // 兜底超时：避免 getSession() 在断网或代理阻断时卡死无回调导致整页永久转圈
    const safetyTimer = setTimeout(() => {
      if (!cancelled) {
        setSessionResolved(true);
      }
    }, 4000);

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      clearTimeout(safetyTimer);
      setSession(data.session);
      setSessionResolved(true);
    }).catch((err) => {
      console.warn('[session] getSession failed, resolving to unauthenticated:', err);
      if (!cancelled) {
        clearTimeout(safetyTimer);
        setSessionResolved(true);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      clearTimeout(safetyTimer);
      setSession(next);
      setSessionResolved(true);
      if (!next) {
        // 登出后必须清空门店缓存，避免下一个登录用户短暂看到上一个用户的门店。
        setLocations([]);
        setClaimable(null);
        setLocationsLoaded(false);
        setMembershipId(null);
        writeStoredMembershipId(null);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      subscription.subscription.unsubscribe();
    };
  }, [queryClient]);

  // ── 网络可用性 ───────────────────────────────────────────────────────────
  /*
   * ⚠️ 不能只听 `online` / `offline` 事件。
   *
   * `navigator.onLine` 只反映**网卡有没有链路** —— 门店最常见的故障是
   * 「连着 WiFi 但路由器出不去」，那时它仍然是 true：界面照常把写按钮
   * 点亮，每一次点击都以网络错误收场，而只读降级从头到尾没有生效。
   *
   * `lib/offline.ts` 的 `watchNetwork` 正是为此写的（对自家 /health 打心跳），
   * 但此前**没有任何调用方** —— 写好了、注释写明了理由，然后没人用它。
   *
   * 恢复联网时顺带整体重取一次：门店 iPad 常年开着不切走，
   * `refetchOnWindowFocus` 等不到那个时机，断网期间的旧数据会一直挂在屏上。
   */
  useEffect(() => {
    let wasOffline = false;
    return watchNetwork(API_BASE, (state) => {
      const online = state === 'online';
      /* 写闸门由下面那个 useLayoutEffect 跟着 isOnline 走，这里不重复设置 */
      setIsOnline(online);
      if (online && wasOffline) void queryClient.invalidateQueries();
      wasOffline = !online;
    });
  }, [queryClient]);

  // ── 门店列表与待开通门店 ───────────────────────────────────────────────────
  const reloadLocations = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetchLocationsAndClaimable();
      const list = res.locations;
      setLocations(list);
      setClaimable(res.claimable);
      setLoadError(null);

      // 已记忆的门店必须存在于服务端返回的集合中，否则视为失效。
      setMembershipId((current) => {
        if (current && list.some((x) => x.membershipId === current)) return current;
        if (current) writeStoredMembershipId(null);
        if (list.length === 1) {
          writeStoredMembershipId(list[0]!.membershipId);
          return list[0]!.membershipId;
        }
        return null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'UNKNOWN');
    } finally {
      setLocationsLoaded(true);
    }
  }, [session]);

  const claimStore = useCallback(async () => {
    await claimLocation();
    await reloadLocations();
  }, [reloadLocations]);

  useEffect(() => {
    if (session) void reloadLocations();
  }, [session, reloadLocations]);

  const [portalPreference, setPortalPreference] = useState<PortalType | null>(readStoredPortal);

  const setPortal = useCallback((p: PortalType) => {
    setPortalPreference(p);
    writeStoredPortal(p);
  }, []);

  const switchPortal = useCallback(() => {
    setPortalPreference((cur) => {
      const next = cur === 'tech' ? 'admin' : 'tech';
      writeStoredPortal(next);
      return next;
    });
  }, []);

  const selectMembership = useCallback((id: string, portal?: PortalType) => {
    setMembershipId(id);
    writeStoredMembershipId(id);
    if (portal) {
      setPortalPreference(portal);
      writeStoredPortal(portal);
    }
  }, []);

  const clearMembership = useCallback(() => {
    setMembershipId(null);
    writeStoredMembershipId(null);
  }, []);

  const signOut = useCallback(async () => {
    writeStoredPortal(null);
    setPortalPreference(null);
    writeStoredMembershipId(null);
    /*
     * ⭐ 退出必须把本地租户数据一起带走（AUD-12）。
     *
     * 内存里的 TanStack 缓存由下面那个 membership 变化的 effect 清掉；
     * 但**离线看板的 IndexedDB 快照原来没人清** —— 里面是今日预约、
     * 排队和工单，含客人姓名与手机号，退出之后一直留在磁盘上。
     * 前台那台电脑是共用的。
     *
     * 顺序：先清本地，再调 signOut。反过来的话，`onAuthStateChange`
     * 会先把组件卸载掉，清理就不一定跑得完。
     */
    queryClient.clear();
    await clearCache();
    await supabase.auth.signOut();
  }, [queryClient]);

  const permissionSet = useMemo(
    () => new Set(context?.permissions ?? []),
    [context],
  );

  const can = useCallback(
    (permission: string) => permissionSet.has(permission),
    [permissionSet],
  );

  /*
   * 认证失效时终止会话。
   *
   * ⚠️ 仅在已建立会话时注册。未登录状态下 `authHeaders` 也会触发该回调，
   * 若无条件注册会在登录页产生一次无意义的 signOut 调用。
   */
  useEffect(() => {
    if (!session) return undefined;
    setUnauthenticatedHandler(() => { void supabase.auth.signOut(); });
    return () => setUnauthenticatedHandler(null);
  }, [session]);

  const membership = useMemo(
    () => locations.find((x) => x.membershipId === membershipId) ?? null,
    [locations, membershipId],
  );

  const isTechCapable = useMemo(
    () => (membership?.roleKeys.some((r) => r === 'tech' || r === 'senior_tech') || Boolean(membership?.isBookable)) ?? false,
    [membership],
  );

  const isManagementCapable = useMemo(
    () => membership?.roleKeys.some((r) => r === 'owner' || r === 'manager' || r === 'front_desk') ?? false,
    [membership],
  );

  const isPureTech = useMemo(
    () => isTechCapable && !isManagementCapable,
    [isTechCapable, isManagementCapable],
  );

  const isDualRole = useMemo(
    () => isTechCapable && isManagementCapable,
    [isTechCapable, isManagementCapable],
  );

  /*
   * 是否手机端 —— 决定双角色用户默认进技师工作台还是前台工作台。
   *
   * ⚠️ 判定依据只能是屏幕尺寸，不能是「独立全屏模式」。门店 iPad 恰恰是以
   * 「添加到主屏幕」的方式常驻使用的，`display-mode: standalone` 在 iPad 上必定
   * 为真；把它当作手机信号，等于让每一台 iPad 上的店长兼技师都被强制丢进技师
   * 工作台，前台工作台在该设备上再也打不开。
   *
   * 同时以较短边而非 `innerWidth` 为准：手机横屏的 innerWidth 可达 800 以上，
   * 按宽度判定会在用户一转屏时把工作台整个换掉。较短边在手机上不超过 ~430px，
   * 在 iPad 上不低于 744px，两类设备在任何方向下都稳定落在正确的一侧。
   */
  const isMobileClient = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return Math.min(window.innerWidth, window.innerHeight) < 600;
  }, []);

  const activePortal: PortalType = useMemo(() => {
    if (portalPreference) return portalPreference;
    if (isPureTech) return 'tech';
    if (isDualRole) return isMobileClient ? 'tech' : 'admin';
    return isMobileClient && isTechCapable ? 'tech' : 'admin';
  }, [portalPreference, isPureTech, isDualRole, isMobileClient, isTechCapable]);

  /*
   * 将当前门店同步到请求层。
   *
   * ⚠️ 使用 useLayoutEffect 而非 useEffect：React 保证所有 layout effect
   * 先于任何 passive effect 执行，因此本注入必定早于子组件在 useEffect 中发出的
   * 第一个带店请求，不存在缺失 X-Membership-Id 的时间窗。
   *
   * ⚠️ 不可在渲染期直接赋值：并发渲染中被丢弃的渲染同样会执行该语句，
   * 可能写入一个从未提交的门店。
   */
  useLayoutEffect(() => {
    setActiveMembershipId(membership?.membershipId ?? null);
  }, [membership]);

  useLayoutEffect(() => {
    setCommandGuard(isOnline);
  }, [isOnline]);

  /*
   * 拉取当前门店的操作上下文。
   *
   * ⚠️ 必须在 membership 注入请求层之后执行 —— 该请求本身需要携带
   * `X-Membership-Id`。此处依赖 useLayoutEffect 与 useEffect 的执行顺序：
   * 上方的注入是 layout effect，本 effect 是 passive effect，前者必定先执行。
   *
   * 上下文获取失败时不阻断进入应用：门店与身份已经确定，此时把用户挡在门外
   * 无助于恢复。降级表现为「权限集为空」，即所有写入口不可用 ——
   * 这与断网降级为只读是同一种处理，且是安全的方向。
   */
  useEffect(() => {
    const id = membership?.membershipId;
    if (!id) {
      setContext(null);
      return undefined;
    }
    let cancelled = false;
    void fetchMembershipContext(id)
      .then((next) => { if (!cancelled) setContext(next); })
      .catch(() => { if (!cancelled) setContext(null); });
    return () => { cancelled = true; };
  }, [membership]);

  /*
   * 门店切换时清空查询缓存。
   *
   * ⚠️ 这是数据正确性要求，不是性能优化：缓存键若不含门店维度，
   * 切换门店后会先渲染上一家门店的数据再被新数据覆盖。对多店经营者而言，
   * 这是一次跨门店的数据呈现，必须消除。
   *
   * 清空而非失效（invalidate）：失效会保留旧数据作为占位继续渲染，
   * 恰好是要避免的行为。
   */
  const previousMembershipRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const next = membership?.membershipId ?? null;
    if (previousMembershipRef.current !== null && previousMembershipRef.current !== next) {
      queryClient.clear();
    }
    previousMembershipRef.current = next;
  }, [membership, queryClient]);

  const status: SessionStatus = useMemo(() => {
    if (!sessionResolved) return 'loading';
    if (!session) return 'unauthenticated';
    if (!locationsLoaded) return 'loading';
    if (membership) return 'ready';
    /*
     * 顺序不可调整：请求失败必须先于「无门店」判定。
     * 否则一次网络抖动会被呈现为「该账号无可用门店」—— 这是一个关于账号权限的
     * 错误结论，会引导用户去联系管理员而不是重试。
     */
    if (loadError) return 'error';
    if (locations.length === 0) return 'no-membership';
    return 'selecting';
  }, [sessionResolved, session, locationsLoaded, membership, locations.length, loadError]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status, session, locations, membership, claimable, context, can,
      membershipId: membership?.membershipId ?? null,
      isOnline, loadError,
      activePortal, portalPreference,
      isTechCapable, isPureTech, isManagementCapable, isDualRole,
      setPortal, switchPortal,
      selectMembership, claimStore, clearMembership, reloadLocations, signOut,
    }),
    [status, session, locations, membership, claimable, context, can, isOnline, loadError,
     activePortal, portalPreference, isTechCapable, isPureTech, isManagementCapable, isDualRole,
     setPortal, switchPortal, selectMembership, claimStore, clearMembership, reloadLocations, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
