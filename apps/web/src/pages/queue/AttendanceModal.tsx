/**
 * 技师考勤打卡与轮牌管理。
 *
 * 与看板本身没有数据耦合，只是共用同一份轮牌与员工数据，因此单独成文件。
 * 顺位严格按 `position` 呈现：轮牌是门店里最容易起争议的一块，界面上的
 * 先后必须与服务端认定的顺位完全一致。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Check, Clock, Coffee, LogIn, LogOut, Search, Sparkles,
  TrendingUp, UserCheck, Users,
} from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useLanguage } from '@/LanguageContext';
import type { RotationEntryState } from '@/features/rotation/types';

/** 考勤面板里的一行。轮牌里没有的在岗技师也要出现，否则打不了卡。 */
export interface AttendanceRow {
  membershipId: string;
  name: string;
  state: RotationEntryState;
  position: number | null;
  turns: number;
  owed: number;
  arrivedAt: string | null;
  leftAt: string | null;
  levelName?: string | null;
}

export interface AttendanceModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  search: string;
  onSearchChange: (value: string) => void;
  filteredStaffAttendance: AttendanceRow[];
  onDutyStaff: AttendanceRow[];
  offDutyStaff: AttendanceRow[];
  nextUpStaff: AttendanceRow | null;
  attendanceMetrics: {
    total: number; onDuty: number; available: number;
    onBreak: number; inService: number; off: number;
  };
  onCheckIn: (staffMember: { membershipId: string; name: string }) => void | Promise<void>;
  onCheckOut: (staffMember: { membershipId: string; name: string }) => void | Promise<void>;
  onBreak: (staffMember: { membershipId: string; name: string }, start: boolean) => void | Promise<void>;
  /** 正在提交打卡的那一位。逐行显示 spinner，避免整面板锁死。 */
  actingStaffId: string | null;
}

export function AttendanceModal({
  isOpen, onOpenChange, search, onSearchChange,
  filteredStaffAttendance, onDutyStaff, offDutyStaff, nextUpStaff, attendanceMetrics,
  onCheckIn, onCheckOut, onBreak, actingStaffId,
}: AttendanceModalProps) {
  const { t } = useLanguage();
  const navigate = useNavigate();

  return (
  <Modal
    isOpen={isOpen}
    onOpenChange={onOpenChange}
    title={
      <div className="flex items-center gap-2 text-slate-900 font-bold">
        <UserCheck className="w-5 h-5 text-teal-600" />
        <span>{t('queue.quStaffPunchModalTitle')}</span>
      </div>
    }
    description={t('queue.quStaffPunchModalDesc')}
    size="md"
    className="max-w-xl"
    footer={
      <div className="flex items-center justify-end w-full">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onOpenChange(false)}
          className="px-4 text-xs font-semibold"
        >
          {t('close')}
        </Button>
      </div>
    }
  >
    <div className="space-y-3 py-1 text-xs text-slate-700">
      {/* 状态统计指示条 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-semibold border border-slate-200">
          {t('queue.quStaffTotalCount', { p0: attendanceMetrics.total })}
        </span>
        <span className="px-2 py-0.5 rounded-lg bg-emerald-50 text-emerald-800 font-semibold border border-emerald-200 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
          {t('queue.quStaffStatusAvailable')}: {attendanceMetrics.available}
        </span>
        <span className="px-2 py-0.5 rounded-lg bg-violet-50 text-violet-800 font-semibold border border-violet-200 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-500 inline-block" />
          {t('queue.quStaffStatusInService')}: {attendanceMetrics.inService}
        </span>
        <span className="px-2 py-0.5 rounded-lg bg-amber-50 text-amber-800 font-semibold border border-amber-200 flex items-center gap-1">
          <Coffee className="w-3 h-3 text-amber-600" />
          {t('queue.quStaffStatusOnBreak')}: {attendanceMetrics.onBreak}
        </span>
      </div>

      {/* 详细排牌引导条 */}
      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-teal-50/70 border border-teal-100/80 text-teal-900 text-xs">
        <span className="flex items-center gap-1.5 text-[11px] text-teal-800 truncate">
          <Sparkles className="w-3.5 h-3.5 text-teal-600 shrink-0" />
          <span className="truncate">{t('queue.quGoToRotationDesc')}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
            navigate('/rotation');
          }}
          className="text-[11px] font-bold text-teal-700 hover:text-teal-900 flex items-center gap-0.5 shrink-0 ml-2 hover:underline cursor-pointer"
        >
          <span>{t('queue.quGoToRotation')}</span>
          <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      {/* 实时搜索框 */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
        <input
          type="text"
          placeholder={t('queue.quStaffSearchPlaceholder')}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50/60 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/20 font-medium"
        />
      </div>

      {/* 技师列表（轮牌队列与打卡） */}
      <div className="max-h-[50vh] overflow-y-auto space-y-3 pr-1 custom-scrollbar">
        {filteredStaffAttendance.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            {t('queue.quNoMatch')}
          </div>
        ) : (
          <>
            {/* 1. 当前轮牌队列（在岗技师，严格按顺位呈现） */}
            {onDutyStaff.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold text-slate-500 flex items-center justify-between px-0.5 pt-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-teal-500" />
                    <span>{t('queue.quRotationActiveQueue')} ({onDutyStaff.length})</span>
                  </span>
                  {nextUpStaff && (
                    <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100/80 border border-emerald-300 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-ping" />
                      <span>
                        ★ #{nextUpStaff.position !== null && nextUpStaff.position !== undefined ? nextUpStaff.position + 1 : onDutyStaff.indexOf(nextUpStaff) + 1} {nextUpStaff.name} {t('queue.quRotationNextUp')}
                      </span>
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  {onDutyStaff.map((s, idx) => {
                    const isActing = actingStaffId === s.membershipId;
                    const isAvailable = s.state === 'available';
                    const isOnBreak = s.state === 'on_break';
                    const isInService = s.state === 'in_service';
                    const isNextUp = nextUpStaff?.membershipId === s.membershipId;
                    const rankNumber = s.position !== null && s.position !== undefined ? s.position + 1 : idx + 1;

                    let statusBadge: React.ReactNode = null;
                    if (isNextUp) {
                      statusBadge = (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-900 border border-emerald-300 font-black">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                          {t('queue.quRotationNextUp')}
                        </span>
                      );
                    } else if (isAvailable) {
                      statusBadge = (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          {t('queue.quStaffStatusAvailable')}
                        </span>
                      );
                    } else if (isInService) {
                      statusBadge = (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 font-bold">
                          <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                          {t('queue.quStaffStatusInService')}
                        </span>
                      );
                    } else if (isOnBreak) {
                      statusBadge = (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                          <Coffee className="w-3 h-3 text-amber-600" />
                          {t('queue.quStaffStatusOnBreak')}
                        </span>
                      );
                    }

                    return (
                      <div
                        key={s.membershipId}
                        className={cn(
                          "p-2.5 bg-white border rounded-xl flex items-center justify-between gap-2.5 transition-all",
                          isNextUp
                            ? "border-emerald-300 bg-emerald-50/20 shadow-xs ring-1 ring-emerald-400/30"
                            : "border-slate-200 hover:border-teal-200 shadow-2xs"
                        )}
                      >
                        {/* 顺位与信息 */}
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={cn(
                              "w-8 h-8 rounded-xl flex items-center justify-center font-black text-xs shrink-0 border shadow-2xs",
                              isNextUp
                                ? "bg-gradient-to-br from-emerald-500 to-teal-600 text-white border-emerald-600"
                                : "bg-slate-100 text-slate-700 border-slate-200"
                            )}
                            title={isNextUp ? t('queue.quRotationNextUp') : t('queue.quRotationRank', { p0: rankNumber })}
                          >
                            #{rankNumber}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-xs text-slate-900 truncate">{s.name}</span>
                              {s.levelName && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 border border-slate-200 font-medium">
                                  {s.levelName}
                                </span>
                              )}
                              {statusBadge}
                            </div>
                            <div className="text-[10px] text-slate-500 flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="font-semibold text-slate-700">
                                {t('queue.quRotationTurnsDone', { p0: s.turns })}
                              </span>
                              {s.owed > 0 && (
                                <span className="text-amber-700 bg-amber-50 px-1 py-0.2 rounded font-bold border border-amber-200">
                                  {t('queue.quRotationOwedTurns', { p0: s.owed })}
                                </span>
                              )}
                              {s.arrivedAt && (
                                <span className="text-slate-400 font-mono">
                                  {t('queue.quArrivedAtPrefix', { p0: s.arrivedAt.slice(11, 16) })}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* 操作按钮 */}
                        <div className="flex items-center gap-1.5 shrink-0 justify-end">
                          {/* 休息来回切换 */}
                          {isOnBreak ? (
                            <Button
                              size="sm"
                              className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-7.5 px-2.5 gap-1 shadow-2xs rounded-xl"
                              onClick={() => onBreak(s, false)}
                              disabled={isActing}
                            >
                              {isActing ? (
                                <Spinner size="sm" className="w-3 h-3 text-white" />
                              ) : (
                                <Coffee className="w-3 h-3" />
                              )}
                              <span>{t('queue.quStaffEndBreak')}</span>
                            </Button>
                          ) : isAvailable ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100 font-bold text-xs h-7.5 px-2.5 gap-1 shadow-2xs rounded-xl"
                              onClick={() => onBreak(s, true)}
                              disabled={isActing}
                            >
                              {isActing ? (
                                <Spinner size="sm" className="w-3 h-3 text-amber-600" />
                              ) : (
                                <Coffee className="w-3 h-3" />
                              )}
                              <span>{t('queue.quStaffStartBreak')}</span>
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled
                              className="opacity-40 cursor-not-allowed text-slate-400 text-xs h-7.5 px-2.5 gap-1 border-slate-200 rounded-xl"
                              title={isInService ? t('queue.quStaffInServiceCantBreak') : undefined}
                            >
                              <Coffee className="w-3 h-3" />
                              <span>{t('queue.quStaffBreak')}</span>
                            </Button>
                          )}

                          {/* 下班打卡 */}
                          <Button
                            size="sm"
                            variant="secondary"
                            className={cn(
                              "font-bold text-xs h-7.5 px-2.5 gap-1 rounded-xl",
                              isInService
                                ? "opacity-40 cursor-not-allowed text-slate-400 border-slate-200"
                                : "border-rose-200 text-rose-700 hover:bg-rose-50"
                            )}
                            onClick={() => {
                              if (isInService) {
                                toast.warning(t('queue.quStaffInServiceCantClockOut'));
                                return;
                              }
                              void onCheckOut(s);
                            }}
                            disabled={isActing || isInService}
                            title={isInService ? t('queue.quStaffInServiceCantClockOut') : undefined}
                          >
                            {isActing ? (
                              <Spinner size="sm" className="w-3 h-3 text-rose-600" />
                            ) : (
                              <LogOut className="w-3 h-3" />
                            )}
                            <span>{t('queue.quStaffClockOut')}</span>
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 2. 未上牌 / 已离店技师 */}
            {offDutyStaff.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[11px] font-bold text-slate-400 flex items-center justify-between px-0.5 border-t border-slate-100 pt-2.5">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-slate-300" />
                    <span>{t('queue.quRotationOffDutyQueue')} ({offDutyStaff.length})</span>
                  </span>
                </div>

                <div className="space-y-1.5">
                  {offDutyStaff.map((s) => {
                    const isActing = actingStaffId === s.membershipId;
                    return (
                      <div
                        key={s.membershipId}
                        className="p-2.5 bg-white border border-slate-200 rounded-xl flex items-center justify-between gap-2.5 shadow-2xs hover:border-teal-200 transition-all opacity-85 hover:opacity-100"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="w-8 h-8 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center font-bold text-xs shrink-0 border border-dashed border-slate-200"
                            title={t('queue.quStaffStatusOff')}
                          >
                            —
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-xs text-slate-700 truncate">{s.name}</span>
                              {s.levelName && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-500 border border-slate-200 font-medium">
                                  {s.levelName}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                {s.state === 'off' ? t('queue.quStaffStatusOff') : t('queue.quStaffStatusNotArrived')}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5 font-mono">
                              {s.leftAt && <span>{t('queue.quLeftAtPrefix', { p0: s.leftAt.slice(11, 16) })}</span>}
                              {s.turns > 0 && <span>{t('queue.quRotationTurnsDone', { p0: s.turns })}</span>}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0 justify-end">
                          <Button
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs h-7.5 px-3 gap-1 shadow-2xs rounded-xl"
                            onClick={() => onCheckIn(s)}
                            disabled={isActing}
                          >
                            {isActing ? (
                              <Spinner size="sm" className="w-3 h-3 text-white" />
                            ) : (
                              <LogIn className="w-3 h-3" />
                            )}
                            <span>{t('queue.quStaffClockIn')}</span>
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  </Modal>
  );
}
