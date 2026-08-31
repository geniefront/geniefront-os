/**
 * 日程数据层。
 *
 * 读：`GET /v1/desk/day` 一次取全当日快照（技师、服务、房间、item），
 * 不拆成多个接口 —— 门店网络条件差，一次往返比多次可靠。
 *
 * 写：一律经由命令总线 `/v1/commands/:name`，界面不得直接 POST 业务接口。
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { CancelReason, DaySnapshot, DaysRange } from './types';

/** 可放行的软容量冲突原因。取值与服务端 `overrideReason` 枚举一致。 */
export const OVERRIDE_REASONS = [
  'guest_requested',
  'staff_on_break',
  'desk_coordination',
  'walk_in_stacking',
  'other',
] as const;

export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

export interface Override {
  reason: OverrideReason;
  note?: string;
}

/**
 * 查询键。**必须包含 membershipId**：多店账号切换门店时若键不含门店维度，
 * 会先渲染上一家门店的数据。`SessionProvider` 在切店时也会清空缓存，
 * 两道措施互为兜底。
 */
export const scheduleKeys = {
  day: (membershipId: string | null, date: string) =>
    ['desk', 'day', membershipId, date] as const,
  range: (membershipId: string | null, from: string, to: string) =>
    ['desk', 'days', membershipId, from, to] as const,
};

/** 服务端对区间宽度的上限。超出会返回 VALIDATION_FAILED + range_too_wide。 */
export const MAX_RANGE_DAYS = 92;

/**
 * 月视图的按日聚合。
 *
 * 一次请求覆盖整个日历网格（六周共 42 天），而非逐日拉取完整快照 ——
 * 后者是上百次查询，且返回的员工 / 项目 / 房间在格子上完全用不到。
 */
export function useDaysRange(from: string, to: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: scheduleKeys.range(membershipId, from, to),
    queryFn: () => apiGet<DaysRange>(
      `/v1/desk/days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useDaySnapshot(date: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: scheduleKeys.day(membershipId, date),
    queryFn: () => apiGet<DaySnapshot>(`/v1/desk/day?date=${encodeURIComponent(date)}`),
    // 门店未就绪时不得发起带店请求，否则服务端返回 VALIDATION_FAILED。
    enabled: status === 'ready' && membershipId !== null && Boolean(date),
  });
}

/**
 * 多日快照（周视图）。
 *
 * ⚠️ 服务端目前只有单日接口 `GET /v1/desk/day`，因此周视图以并行的 7 次请求实现。
 * 这是可接受的：门店内网延迟低，且 TanStack Query 会复用已缓存的当日结果。
 *
 * ⚠️ **月视图不得沿用此方案** —— 30 余次并行请求会明显拖慢首屏，并在门店网络
 * 抖动时产生大量重试。月视图需要服务端提供区间接口（形如
 * `GET /v1/desk/days?from=&to=`）后再启用。
 */
export function useDayRange(dates: string[]) {
  const { membershipId, status } = useSession();
  const enabled = status === 'ready' && membershipId !== null;

  return useQueries({
    queries: dates.map((date) => ({
      queryKey: scheduleKeys.day(membershipId, date),
      queryFn: () => apiGet<DaySnapshot>(`/v1/desk/day?date=${encodeURIComponent(date)}`),
      enabled,
    })),
  });
}

export interface CreateAppointmentItemInput {
  serviceId: string;
  /** null = 未指派，进入待分配池。 */
  membershipId: string | null;
  startsAt: string;
  durationMin?: number;
  resourceId?: string | null;
  isRequest?: boolean;
}

export interface CreateAppointmentInput {
  customerId: string | null;
  /** 匿名到店客：不建客户档案，仅留姓名，事后可合并。 */
  walkInName?: string;
  items: CreateAppointmentItemInput[];
  notes?: string;
  override?: Override;
}

/**
 * 判断一个错误是否为「可由前台确认后放行」的软容量冲突。
 *
 * ⚠️ 仅软冲突可放行。房间被占属于硬冲突，服务端在任何情况下都不接受 override，
 * 界面不得为其提供确认入口。
 */
export function isOverridableConflict(err: unknown): err is ApiError {
  if (err instanceof ApiError) {
    return err.overridable || ['STAFF_OVER_CAPACITY', 'LOCATION_OVER_CAPACITY', 'STAFF_LACKS_SKILL', 'OUTSIDE_BUSINESS_HOURS'].includes(err.code);
  }
  if (typeof err === 'object' && err !== null) {
    const e = err as any;
    return Boolean(e.overridable || ['STAFF_OVER_CAPACITY', 'LOCATION_OVER_CAPACITY', 'STAFF_LACKS_SKILL', 'OUTSIDE_BUSINESS_HOURS'].includes(e.code));
  }
  return false;
}

export function useCreateAppointment(date: string) {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    /**
     * ⚠️ `appointment.create` 的幂等键是**必填**。网络不稳时的重试若不带同一个键，
     * 会在门店留下重复预约 —— 而重试恰恰在网络差的门店最常发生。
     * 每次调用生成一个新键，由调用方在重试同一意图时复用。
     */
    /*
     * 在数据层解包 `CommandResult`，调用方直接拿到命令的 output。
     * `replayed`（幂等重放）不向界面透出：对前台而言「重试后成功」与
     * 「首次成功」是同一件事。
     */
    mutationFn: async (input: CreateAppointmentInput & { idempotencyKey?: string }) =>
      (await runCommand<{ appointmentId: string; itemIds: string[]; overbookedItemIds: string[] }>(
        'appointment.create',
        {
          customerId: input.customerId,
          ...(input.walkInName ? { walkInName: input.walkInName } : {}),
          items: input.items.map((it) => ({
            serviceId: it.serviceId,
            membershipId: it.membershipId,
            startsAt: it.startsAt,
            isRequest: it.isRequest ?? false,
            resourceId: it.resourceId ?? null,
            ...(it.durationMin ? { durationMin: it.durationMin } : {}),
          })),
          source: 'desk',
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.override ? { override: input.override } : {}),
        },
        membershipId!,
        input.idempotencyKey,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.day(membershipId, date) });
    },
  });
}

export interface RescheduleInput {
  appointmentId: string;
  /** 不传 = 整单平移；传 itemId = 仅移动该条目。 */
  itemId?: string;
  startsAt: string;
  membershipId?: string | null;
  resourceId?: string | null;
  override?: Override;
}

export function useRescheduleAppointment(date: string) {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RescheduleInput) =>
      (await runCommand<{ appointmentId: string; overbooked: boolean }>(
        'appointment.reschedule',
        {
          appointmentId: input.appointmentId,
          ...(input.itemId ? { itemId: input.itemId } : {}),
          startsAt: input.startsAt,
          ...(input.membershipId !== undefined ? { membershipId: input.membershipId } : {}),
          ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
          ...(input.override ? { override: input.override } : {}),
        },
        membershipId!,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.day(membershipId, date) });
    },
  });
}

export interface CancelInput {
  appointmentId: string;
  reason: CancelReason;
  note?: string;
  /**
   * ⚠️ 无默认值，调用方必须显式选择。
   *
   * 取消时若技师已被占用，需要决定是否为其保留本次轮牌与档期。不作选择时
   * 系统会认为技师未服务，释放档期并打乱轮牌队列 —— 门店当日排班会全乱，
   * 而这是一个事后难以还原的状态。
   */
  keepStaffTurn: boolean;
}

export function useCancelAppointment(date: string) {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: CancelInput) =>
      (await runCommand<{ appointmentId: string; turnKept: boolean }>(
        'appointment.cancel',
        {
          appointmentId: input.appointmentId,
          reason: input.reason,
          ...(input.note ? { note: input.note } : {}),
          keepStaffTurn: input.keepStaffTurn,
        },
        membershipId!,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.day(membershipId, date) });
    },
  });
}
