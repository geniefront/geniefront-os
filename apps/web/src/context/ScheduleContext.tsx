/**
 * 日程数据上下文。
 *
 * 数据源为 `GET /v1/desk/day` 的当日快照。本文件负责把服务端的 item 级模型
 * 适配为日历渲染所需的形态，并把三条写操作收敛为命令总线调用。
 *
 * ## 与服务端模型的关键差异
 *
 * 服务端以 **appointment item** 为最小单位：一个 appointment 可包含多条 item
 * （一单多服务、同行多人各做一项），每条 item 独立绑定技师、房间与时段，
 * 冲突检测也在 item 级完成。日历上的每一个色块对应一条 item，不是一个 appointment。
 *
 * ## 冲突判定不在前端
 *
 * 软容量冲突（超技师并发、超门店时段上限）由服务端返回 409 且 `overridable=true`，
 * 前台确认后带 `override` 重试。硬冲突（房间被占）服务端永不放行。
 * 前端不得自行推算冲突 —— 那是把权威判定抄了第二份，且必然与服务端分叉。
 */
import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { useSession } from '@/lib/session';
import { instantToWallMinutes, instantToWallDate, formatWallTime } from '@/lib/time';
import { formatI18n } from '@/lib/utils';
import {
  useDaySnapshot, useDayRange, useCreateAppointment, useRescheduleAppointment,
  useCancelAppointment,
} from '@/features/schedule/api';
import { serviceColor } from '@/features/schedule/colors';
import type {
  DaySnapshot, DayService, DayStaff, DayResource, CancelReason,
} from '@/features/schedule/types';
import { useBusinessDay } from '@/lib/time';
import { useLanguage } from '@/LanguageContext';

/** 未指派技师的虚拟列。服务端以 `membershipId === null` 表示。 */
export const UNASSIGNED_STAFF_ID = '__unassigned__';

export type ItemStatus = 'booked' | 'in_service' | 'completed' | 'no_show' | 'cancelled';

/**
 * 日历上的一个色块 = 一条 appointment item。
 *
 * 时间以门店墙上时间的分钟数表示，已按门店时区换算完毕。
 * 营业至次日凌晨的门店，其分钟数可超过 1440。
 */
export interface ScheduleItem {
  /** itemId。日历中的唯一键。 */
  id: string;
  appointmentId: string;
  /** membershipId，未指派时为 UNASSIGNED_STAFF_ID。 */
  staffId: string;
  serviceName: string;
  serviceId: string;
  /**
   * 当前项目定义。
   *
   * ⚠️ 可能为 null：`services[]` 只含在售项目，而已下架项目的历史单仍在
   * `items` 里。为 null 时一律回退到 item 自带的 `serviceName` / `durationMin`,
   * 它们是下单那一刻的快照，比当前项目表更准确。
   */
  service: DayService | null;
  customerName: string;
  customerPhone?: string | null;
  startMins: number;
  endMins: number;
  durationMin: number;
  status: ItemStatus;
  /** 点钟单（客人指名技师）。 */
  isRequest: boolean;
  /** 超出软容量后经确认放行，需在看板上高亮。 */
  overbooked: boolean;
  resourceId: string | null;
  /** 展示用 `HH:mm`。 */
  startTime: string;
  endTime: string;
  /** 实际完工 ISO。看板「已完工」必须用它，不能用预约 endTime。 */
  completedAt?: string | null;
  /** 该 item 所属的营业日 `YYYY-MM-DD`。周视图按它分组。 */
  date: string;
}

interface ScheduleContextValue {
  /** 当前查看的营业日 `YYYY-MM-DD`。 */
  currentDate: string;
  setCurrentDate: (date: string) => void;

  snapshot: DaySnapshot | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;

  services: DayService[];
  /**
   * 技师列表，**首位为「待分配池」虚拟列**（membershipId 为
   * UNASSIGNED_STAFF_ID）。未指派技师的 item 归入该列，前台据此派单。
   * 服务端不返回这一列，它是界面概念。
   */
  staff: DayStaff[];
  resources: DayResource[];
  /** 当日全部 item，已按门店时区换算为墙上分钟数。 */
  items: ScheduleItem[];

  /** 门店时区。所有时间换算必须使用它，不得使用浏览器时区。 */
  timezone: string;
  /** 营业起止（墙上分钟）。 */
  openMin: number;
  closeMin: number;
}

const ScheduleContext = createContext<ScheduleContextValue | undefined>(undefined);

/** 服务端状态到本地类型的收敛。未知取值一律按 booked 处理，不隐藏该 item。 */
function normalizeStatus(raw: string): ItemStatus {
  switch (raw) {
    case 'in_service': return 'in_service';
    case 'done':
    case 'completed': return 'completed';
    case 'no_show': return 'no_show';
    // 服务端已在 SQL 层过滤掉 cancelled，此分支仅为防御。
    case 'cancelled': return 'cancelled';
    default: return 'booked';
  }
}

export function ScheduleProvider({ children }: { children: ReactNode }) {
  const { membershipId } = useSession();
  const { t } = useLanguage();
  /**
   * 默认日期取门店的**营业日**今天 —— 不是浏览器本地日期、不是 UTC、
   * 也不是门店时区的日历日（AUD-13）。
   *
   * 时区/cutoff 尚未就绪时不猜日期：先猜一个再纠正，会让首屏用错误的
   * `?date=` 打一发请求，而那正是 QA-008 留下的尾巴。
   */
  const { ready: dayReady, today: businessToday, timezone } = useBusinessDay();
  const [currentDate, setCurrentDate] = useState(() => (dayReady ? businessToday : ''));
  useEffect(() => {
    if (!dayReady) return;
    setCurrentDate(businessToday);
  }, [dayReady, businessToday, membershipId]);

  const query = useDaySnapshot(currentDate);
  const snapshot = query.data;

  const staff = useMemo<DayStaff[]>(() => {
    /*
     * ⚠️ 服务端返回的 staff 包含前台等不可预约人员（isBookable: false）。
     * 日程表按人分列时必须过滤，否则会多出永远为空的列，
     * 在技师较多的门店会显著挤占横向空间。
     */
    const real = (snapshot?.staff ?? []).filter((s) => s.isBookable);
    return [
      {
        membershipId: UNASSIGNED_STAFF_ID,
        name: '',            // 展示文案由界面按当前语言取，不在此处硬编码
        isBookable: true,
        inRotation: false,
        maxConcurrent: Number.MAX_SAFE_INTEGER, // 待分配池不受并发上限约束
        color: null,
        levelName: null,
        skills: [],
      },
      ...real,
    ];
  }, [snapshot]);

  const items = useMemo<ScheduleItem[]>(() => {
    if (!snapshot) return [];
    const servicesById = new Map(snapshot.services.map((sv) => [sv.id, sv]));
    return snapshot.items.map((item) => toScheduleItem(item, snapshot, servicesById, { service: t('service'), customer: t('customer') }));
  }, [snapshot, t]);

  const value = useMemo<ScheduleContextValue>(() => ({
    currentDate,
    setCurrentDate,
    snapshot,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => { void query.refetch(); },
    services: snapshot?.services ?? [],
    staff,
    resources: snapshot?.resources ?? [],
    items,
    timezone: snapshot?.timezone ?? timezone ?? '',
    openMin: snapshot?.openMin ?? 9 * 60,
    closeMin: snapshot?.closeMin ?? 21 * 60,
  }), [currentDate, snapshot, query.isLoading, query.error, query.refetch, items, staff, timezone]);

  return <ScheduleContext.Provider value={value}>{children}</ScheduleContext.Provider>;
}

/** 服务端 item → 日历色块。时间在此统一换算为门店墙上分钟数。 */
export function toScheduleItem(
  item: DaySnapshot['items'][number],
  snapshot: DaySnapshot,
  servicesById: Map<string, DayService>,
  /** 名称缺失时的兜底文案——由调用方按当前语言传入，这里不写死中文 */
  fallbacks: { service: string; customer: string },
): ScheduleItem {
  const startMins = toBusinessDayMinutes(item.startsAt, snapshot);
  const endMins = toBusinessDayMinutes(item.endsAt, snapshot);
  return {
    id: item.itemId,
    appointmentId: item.appointmentId,
    staffId: item.membershipId ?? UNASSIGNED_STAFF_ID,
    serviceId: item.serviceId,
    serviceName: formatI18n(item.serviceName) || fallbacks.service,
    service: servicesById.get(item.serviceId) ?? null,
    customerName: formatI18n(item.customerName) || fallbacks.customer,
    customerPhone: item.customerPhone ?? null,
    startMins,
    endMins,
    durationMin: item.durationMin,
    status: normalizeStatus(item.status),
    isRequest: item.isRequest,
    overbooked: item.overbooked,
    resourceId: item.resourceId,
    startTime: formatWallTime(startMins),
    endTime: formatWallTime(endMins),
    completedAt: item.completedAt ?? null,
    date: snapshot.businessDate,
  };
}

/**
 * 把一个时刻换算为「相对该营业日起点的墙上分钟数」。
 *
 * ⚠️ 营业至次日凌晨的门店，其营业日尾段落在下一个自然日，墙上分钟数会回绕到
 * 小数值。此处按日期差补上整日分钟数，使同一营业日内的时间轴保持单调递增 ——
 * 否则凌晨 1:00 的单会被画到当日 1:00 的位置，排在所有单子的最前面。
 */
function toBusinessDayMinutes(iso: string, snapshot: DaySnapshot): number {
  const minutes = instantToWallMinutes(iso, snapshot.timezone);
  const wallDate = instantToWallDate(iso, snapshot.timezone);
  if (wallDate === snapshot.businessDate) return minutes;
  const dayDelta = Math.round(
    (Date.parse(`${wallDate}T00:00:00Z`) - Date.parse(`${snapshot.businessDate}T00:00:00Z`))
    / 86_400_000,
  );
  return minutes + dayDelta * 24 * 60;
}

/**
 * 周视图的多日数据。
 *
 * 返回按营业日索引的 item 集合。调用方只在处于周视图时传入日期数组，
 * 其余视图传空数组以避免无谓请求。
 */
export function useWeekItems(dates: string[]): Map<string, ScheduleItem[]> {
  const results = useDayRange(dates);
  const { t } = useLanguage();
  return useMemo(() => {
    const byDate = new Map<string, ScheduleItem[]>();
    const fallbacks = { service: t('service'), customer: t('customer') };
    for (const r of results) {
      const snap = r.data;
      if (!snap) continue;
      const servicesById = new Map(snap.services.map((sv) => [sv.id, sv]));
      byDate.set(snap.businessDate, snap.items.map((item) => toScheduleItem(item, snap, servicesById, fallbacks)));
    }
    return byDate;
  }, [results, t]);
}

export function useSchedule(): ScheduleContextValue {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within a ScheduleProvider');
  return ctx;
}

/**
 * 日程写操作。与读上下文分开导出，使调用点能明确看到自己在发起写请求。
 * 每个方法对应命令总线上的一条命令，不做本地状态修改。
 */
export function useScheduleMutations() {
  const { currentDate } = useSchedule();
  const create = useCreateAppointment(currentDate);
  const reschedule = useRescheduleAppointment(currentDate);
  const cancel = useCancelAppointment(currentDate);
  return { create, reschedule, cancel };
}

export { serviceColor };
export type { DayService, DayStaff, DayResource, DaySnapshot, CancelReason };
