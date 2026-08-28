import { useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/utils';
import { useStoreTime } from '@/lib/time';
import { useErrorMessage } from '@/lib/errorMessage';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLanguage } from '@/LanguageContext';
import {
  CheckCircle2,
  Clock,
  Sparkles,
  AlertCircle,
  AlertTriangle,
  Plus,
  Edit2,
  Wrench,
  RefreshCw,
  LayoutGrid,
  List,
  Calendar,
  User,
  Scissors,
  Search,
  Timer,
  LogIn,
  Layers,
  Activity,
  Trash2,
  Info,
  MoreVertical,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { toast, Spinner } from '@heroui/react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import {
  useRoomsQuery,
  useSetResourceStatus,
  useSaveResource,
  useDeleteResource,
} from '@/features/rooms/api';
import type { RoomItem, RoomStatus, RoomType, TimelineSlot, RoomSession } from '@/features/rooms/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';

type ViewMode = 'grid' | 'timeline' | 'list';

const MAINTENANCE_PRESETS = [
  '🔧 设施设备损坏维修',
  '🧼 深度消杀与卫生防疫',
  '🔨 软装重装翻新施工',
  '🚰 水电管道检修维护',
  '⛔ 店长指定临时停用',
];

function RoomsContent() {
  const storeTime = useStoreTime();
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { data, isLoading, error, refetch } = useRoomsQuery();
  const setStatusMutation = useSetResourceStatus();
  const saveResourceMutation = useSaveResource();
  const deleteResourceMutation = useDeleteResource();

  // 视图与筛选状态
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // 1. 新增 / 编辑弹窗状态
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<RoomItem | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('room');
  const [capacity, setCapacity] = useState('1');
  const [maxStaff, setMaxStaff] = useState('');

  // 2. 删除确认弹窗状态
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RoomItem | null>(null);
  const [forceDelete, setForceDelete] = useState(false);

  // 3. 维护说明弹窗状态
  const [maintenanceModalOpen, setMaintenanceModalOpen] = useState(false);
  const [maintenanceTarget, setMaintenanceTarget] = useState<RoomItem | null>(null);
  const [maintenanceNote, setMaintenanceNote] = useState('');

  // 4. 安排入座弹窗状态
  const [seatModalOpen, setSeatModalOpen] = useState(false);
  const [seatTarget, setSeatTarget] = useState<RoomItem | null>(null);
  const [seatGuestName, setSeatGuestName] = useState('');
  const [seatServiceName, setSeatServiceName] = useState('');

  // 5. In Service会话详情查看弹窗
  const [sessionDetailModalOpen, setSessionDetailModalOpen] = useState(false);
  const [sessionDetailRoom, setSessionDetailRoom] = useState<RoomItem | null>(null);

  const rooms = data?.rooms ?? [];
  const metrics = data?.metrics ?? {
    total: rooms.length,
    available: rooms.filter((r) => r.status === 'available').length,
    inService: rooms.filter((r) => r.status === 'in_service').length,
    cleaning: rooms.filter((r) => r.status === 'cleaning').length,
    maintenance: rooms.filter((r) => r.status === 'maintenance').length,
    occupancyRate:
      rooms.length > 0
        ? Math.round(
            (rooms.filter((r) => r.status === 'in_service').length / rooms.length) * 100,
          )
        : 0,
  };

  // 动态提取全部资源类型供分类选项卡使用
  const availableTypes = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rooms) {
      const k = r.typeKey || 'room';
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([key, count]) => ({
      key,
      count,
      label:
        key === 'room' || key === 'vip'
          ? t('privateRooms') || '独立包厢'
          : key === 'chair' || key === 'station'
            ? t('nailStations') || '美甲台/椅'
            : key === 'table' || key === 'sofa'
              ? t('pedicureChairs') || '足疗沙发'
              : key === 'bed'
                ? t('massageBeds') || '按摩理疗床'
                : key,
    }));
  }, [rooms, t]);

  // 过滤后的房间列表 (支持错别字容错模糊搜索)
  const filteredRooms = useMemo(() => {
    let list = rooms;
    if (typeFilter !== 'all') {
      list = list.filter((r) => (r.typeKey || 'room') === typeFilter);
    }
    if (statusFilter !== 'all') {
      list = list.filter((r) => r.status === statusFilter);
    }
    if (searchQuery.trim()) {
      list = fuzzySearch(list, searchQuery, {
        keys: [
          { name: 'name', weight: 0.5 },
          { name: 'type', weight: 0.2 },
          { name: 'currentSession.customerName', weight: 0.3 },
          { name: 'currentSession.staffNames', weight: 0.25 },
          { name: 'upcomingSession.customerName', weight: 0.2 },
        ],
        threshold: 0.45,
      });
    }
    return list;
  }, [rooms, typeFilter, statusFilter, searchQuery]);

  // 打开新增弹窗
  const handleOpenAdd = () => {
    setEditingRoom(null);
    setName('');
    setType('room');
    setCapacity('1');
    setMaxStaff('');
    setSaveModalOpen(true);
  };

  // 打开编辑弹窗
  const handleOpenEdit = (r: RoomItem) => {
    setEditingRoom(r);
    setName(r.name);
    setType(r.typeKey || 'room');
    setCapacity(String(r.capacity || 1));
    setMaxStaff(r.maxStaff ? String(r.maxStaff) : '');
    setSaveModalOpen(true);
  };

  // 打开删除确认弹窗
  const handleOpenDelete = (r: RoomItem) => {
    setDeleteTarget(r);
    setForceDelete(false);
    setDeleteModalOpen(true);
  };

  // 保存房间/工位配置
  const handleSaveResource = async () => {
    if (!name.trim()) {
      toast.danger(t('queue.roomNameRequired'));
      return;
    }
    try {
      await saveResourceMutation.mutateAsync({
        resourceId: editingRoom?.id,
        name: name.trim(),
        type,
        capacity: Math.max(1, parseInt(capacity, 10) || 1),
        maxStaff: maxStaff.trim() ? parseInt(maxStaff, 10) || undefined : undefined,
      });
      toast.success(t('saved') || t('queue.roomSaved'));
      setSaveModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 确认删除工位
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteResourceMutation.mutateAsync({
        resourceId: deleteTarget.id,
        force: forceDelete,
      });
      toast.success(t('queue.roomDeleted', { p0: deleteTarget.name }));
      setDeleteModalOpen(false);
      setDeleteTarget(null);
      if (saveModalOpen) setSaveModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 快捷切态
  const handleQuickStatus = async (room: RoomItem, newStatus: RoomStatus, note?: string) => {
    if (newStatus === 'maintenance' && !note) {
      setMaintenanceTarget(room);
      setMaintenanceNote('');
      setMaintenanceModalOpen(true);
      return;
    }

    try {
      await setStatusMutation.mutateAsync({
        resourceId: room.id,
        status: newStatus,
        note,
      });
      const statusLabel =
        newStatus === 'available'
          ? t('roomAvailable') || '空闲待客'
          : newStatus === 'in_service'
            ? t('roomOccupied') || 'In Service'
            : newStatus === 'cleaning'
              ? t('roomCleaning') || '打扫消毒'
              : t('roomMaintenance') || '停用检修';
      toast.success(t('queue.roomStatusUpdated', { p0: room.name, p1: statusLabel }));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 确认维护状态
  const handleConfirmMaintenance = async () => {
    if (!maintenanceTarget) return;
    try {
      await setStatusMutation.mutateAsync({
        resourceId: maintenanceTarget.id,
        status: 'maintenance',
        note: maintenanceNote.trim() || '设备检修维护',
      });
      toast.success(t('queue.roomSetMaintenance', { p0: maintenanceTarget.name }));
      setMaintenanceModalOpen(false);
      setMaintenanceTarget(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 确认快速入座
  const handleConfirmSeat = async () => {
    if (!seatTarget) return;
    try {
      const parts: string[] = [];
      if (seatGuestName.trim()) parts.push(`客人: ${seatGuestName.trim()}`);
      if (seatServiceName.trim()) parts.push(`项目: ${seatServiceName.trim()}`);

      await setStatusMutation.mutateAsync({
        resourceId: seatTarget.id,
        status: 'in_service',
        note: parts.length > 0 ? `前台安排入座 (${parts.join(', ')})` : '前台直接安排客人入座',
      });
      toast.success(t('queue.roomSeated', { p0: seatTarget.name }));
      setSeatModalOpen(false);
      setSeatTarget(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 格式化时间
  const formatTimeStr = (iso?: string | null) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return storeTime.time(d);
    } catch {
      return iso.slice(11, 16) || iso;
    }
  };

  if (isLoading && !data) {
    return <PageLoading title={t('queue.roomLoading')} description={t('queue.roomLoadingDesc')} />;
  }

  if (error && !data) {
    return <PageError title={t('queue.roomLoadError')} error={error} onRetry={refetch} />;
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full pb-16">
      {/* 1. Page Header */}
      <PageHeader
        title={t('roomsTitle') || t('queue.roomBoardTitle')}
        description={
          t('roomsSubtitle') ||
          t('queue.roomBoardDesc')
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => refetch()}
              className="gap-1.5 text-xs font-semibold"
              disabled={isLoading}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('refresh') || t('queue.roomRefresh')}</span>
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold shadow-sm text-xs"
              size="sm"
              onClick={handleOpenAdd}
            >
              <Plus className="w-4 h-4" />
              <span>{t('queue.roomAdd')}</span>
            </Button>
          </div>
        }
      />

      {/* 2. High-Density Operational Status Pill Bar */}
      <div className="bg-white p-2.5 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-slate-100 border border-slate-200 text-xs font-bold text-slate-800">
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            <span>{t('queue.roomTotalStations')}</span>
            <strong className="font-mono text-sm ml-0.5 text-slate-900">{metrics.total}</strong>
          </div>

          <button
            onClick={() => setStatusFilter(statusFilter === 'available' ? 'all' : 'available')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              statusFilter === 'available'
                ? 'bg-emerald-600 text-white border-emerald-700 shadow-xs'
                : 'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{t('queue.roomAvailable')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.available}</strong>
          </button>

          <button
            onClick={() => setStatusFilter(statusFilter === 'in_service' ? 'all' : 'in_service')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              statusFilter === 'in_service'
                ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
                : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>In Service</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.inService}</strong>
          </button>

          <button
            onClick={() => setStatusFilter(statusFilter === 'cleaning' ? 'all' : 'cleaning')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              statusFilter === 'cleaning'
                ? 'bg-teal-600 text-white border-teal-700 shadow-xs'
                : 'bg-teal-50 text-teal-900 border-teal-200 hover:bg-teal-100'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('queue.roomCleaning')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.cleaning}</strong>
          </button>

          <button
            onClick={() => setStatusFilter(statusFilter === 'maintenance' ? 'all' : 'maintenance')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              statusFilter === 'maintenance'
                ? 'bg-rose-600 text-white border-rose-700 shadow-xs'
                : 'bg-rose-50 text-rose-900 border-rose-200 hover:bg-rose-100'
            }`}
          >
            <Wrench className="w-3.5 h-3.5" />
            <span>{t('queue.roomMaintenance')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.maintenance}</strong>
          </button>
        </div>

        <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-indigo-50 border border-indigo-200 text-xs font-bold text-indigo-950 shrink-0">
          <Timer className="w-3.5 h-3.5 text-indigo-600" />
          <span>{t('queue.roomUtilisation')}</span>
          <strong className="font-mono text-sm ml-0.5 text-indigo-900">{metrics.occupancyRate}%</strong>
        </div>
      </div>

      {/* 3. Toolbar: Type Tabs, Status Filter, Search, and View Mode Switcher */}
      <div className="bg-white p-2.5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5">
        {/* Left: Category Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
          <button
            onClick={() => setTypeFilter('all')}
            className={`px-3 py-1 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 ${
              typeFilter === 'all'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>{t('queue.roomAllStations')}</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                typeFilter === 'all' ? 'bg-slate-700 text-white' : 'bg-slate-200 text-slate-700'
              }`}
            >
              {rooms.length}
            </span>
          </button>

          {availableTypes.map((item) => (
            <button
              key={item.key}
              onClick={() => setTypeFilter(item.key)}
              className={`px-3 py-1 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                typeFilter === item.key
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <span>{item.label}</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                  typeFilter === item.key
                    ? 'bg-slate-700 text-white'
                    : 'bg-slate-200 text-slate-700'
                }`}
              >
                {item.count}
              </span>
            </button>
          ))}
        </div>

        {/* Right: Search, Status Dropdown, View Mode Toggle */}
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap justify-between md:justify-end">
          {/* 搜索框 */}
          <div className="relative w-full sm:w-48">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('queue.roomSearchPlaceholder')}
              className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:bg-white transition-all"
            />
          </div>

          {/* 状态下拉 */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label={t('queue.roomFilterByStatus')}
            className="h-8 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-500"
          >
            <option value="all">{t('queue.roomAllStatuses')}</option>
            <option value="available">{t('queue.roomStatusAvailable')}</option>
            <option value="in_service">🟡 In Service</option>
            <option value="cleaning">{t('queue.roomStatusCleaning')}</option>
            <option value="maintenance">{t('queue.roomStatusMaintenance')}</option>
          </select>

          {/* 视图模式切换 */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200 shrink-0">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                viewMode === 'grid'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title={t('viewGrid') || t('queue.roomViewGrid')}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('timeline')}
              className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                viewMode === 'timeline'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title={t('viewTimeline') || t('queue.roomViewGantt')}
            >
              <Calendar className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                viewMode === 'list'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title={t('viewList') || t('queue.roomViewList')}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 4. Main Views */}
      {filteredRooms.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="w-12 h-12 text-slate-300" />}
          title={t('queue.roomNoMatch')}
          description={t('queue.roomNoMatchDesc')}
          action={
            <Button onClick={handleOpenAdd} className="bg-teal-600 hover:bg-teal-700 text-white font-bold">
              
              {t('queue.roomAddTitle')}
            </Button>
          }
        />
      ) : viewMode === 'grid' ? (
        /* ─────────────── View 1: High-Density Grid Cards View ─────────────── */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4 gap-3.5">
          {filteredRooms.map((room) => {
            const isAvail = room.status === 'available';
            const isInService = room.status === 'in_service';
            const isCleaning = room.status === 'cleaning';
            const isMaint = room.status === 'maintenance';

            const session = room.currentSession;
            const isOvertime = session && session.progressMinutes > session.totalMinutes;
            const progressPercent =
              session && session.totalMinutes > 0
                ? Math.min(100, Math.round((session.progressMinutes / session.totalMinutes) * 100))
                : 0;

            const upcoming = room.upcomingSession;
            const isUpcomingSoon = upcoming && upcoming.startsInMinutes <= 30;

            // 边框与背景色彩系统
            let cardBorder = 'border-slate-200 hover:border-slate-300';
            let cardBg = 'bg-white';
            let headerBg = 'bg-slate-50/60';

            if (isAvail) {
              cardBorder = 'border-emerald-300 hover:border-emerald-400';
              cardBg = 'bg-emerald-50/15';
              headerBg = 'bg-emerald-100/50';
            } else if (isInService) {
              cardBorder = isOvertime
                ? 'border-red-400 hover:border-red-500 shadow-sm'
                : 'border-amber-300 hover:border-amber-400';
              cardBg = isOvertime ? 'bg-red-50/25' : 'bg-amber-50/20';
              headerBg = isOvertime ? 'bg-red-100/60' : 'bg-amber-100/50';
            } else if (isCleaning) {
              cardBorder = 'border-teal-300 hover:border-teal-400';
              cardBg = 'bg-teal-50/20';
              headerBg = 'bg-teal-100/50';
            } else if (isMaint) {
              cardBorder = 'border-rose-300 hover:border-rose-400';
              cardBg = 'bg-rose-50/20';
              headerBg = 'bg-rose-100/50';
            }

            return (
              <Card
                key={room.id}
                className={`overflow-hidden border-2 transition-all duration-200 shadow-xs hover:shadow-md flex flex-col justify-between rounded-2xl ${cardBorder} ${cardBg}`}
              >
                <div>
                  {/* Card Header */}
                  <div
                    className={`p-3 border-b border-slate-100 flex items-center justify-between gap-2 ${headerBg}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h3 className="font-extrabold text-slate-900 text-sm leading-tight truncate">
                          {room.name}
                        </h3>
                        <button
                          onClick={() => handleOpenEdit(room)}
                          className="text-slate-400 hover:text-slate-700 p-0.5 rounded transition-colors shrink-0"
                          title={t('queue.roomEditInfo')}
                        >
                          <Edit2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-slate-500 font-medium mt-0.5 whitespace-nowrap truncate">
                        <span className="truncate">{room.type}</span>
                        <span className="shrink-0 text-slate-300">·</span>
                        <span className="shrink-0 font-mono">{t('queue.roomCapacity')} {room.capacity}{t('queue.roomPeopleUnit')}</span>
                        {room.maxStaff && (
                          <>
                            <span className="shrink-0 text-slate-300">·</span>
                            <span className="shrink-0">{t('queue.roomMaxStaffPrefix')} {room.maxStaff}{t('queue.roomStaffUnit')}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {/* 交互式快捷状态选择器 */}
                      <select
                        value={room.status}
                        onChange={(e) => handleQuickStatus(room, e.target.value as RoomStatus)}
                        className={`text-[11px] font-bold px-2 py-0.5 rounded-xl border cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-500/20 transition-all ${
                          isAvail
                            ? 'bg-emerald-50 text-emerald-900 border-emerald-300 hover:bg-emerald-100'
                            : isInService
                            ? isOvertime
                              ? 'bg-red-50 text-red-900 border-red-300 animate-pulse hover:bg-red-100'
                              : 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                            : isCleaning
                            ? 'bg-teal-50 text-teal-900 border-teal-300 hover:bg-teal-100'
                            : 'bg-rose-50 text-rose-900 border-rose-300 hover:bg-rose-100'
                        }`}
                        title={t('queue.roomClickToChange')}
                      >
                        <option value="available">{t('queue.roomFree')}</option>
                        <option value="in_service">🟡 In Service</option>
                        <option value="cleaning">🔵 Cleaning</option>
                        <option value="maintenance">{t('queue.roomUnderMaintenance')}</option>
                      </select>

                      {/* 卡片右上角动作菜单 */}
                      <ActionMenu
                        label={t('queue.roomOptionsTitle', { p0: room.name })}
                        items={[
                          {
                            id: 'status-available',
                            label: t('queue.roomSetAvailable'),
                            icon: <CheckCircle2 className="w-4 h-4 text-emerald-600" />,
                            onSelect: () => handleQuickStatus(room, 'available'),
                          },
                          {
                            id: 'status-in-service',
                            label: t('queue.roomSetInService'),
                            icon: <Activity className="w-4 h-4 text-amber-600" />,
                            onSelect: () => handleQuickStatus(room, 'in_service'),
                          },
                          {
                            id: 'status-cleaning',
                            label: t('queue.roomSetCleaning'),
                            icon: <Sparkles className="w-4 h-4 text-teal-600" />,
                            onSelect: () => handleQuickStatus(room, 'cleaning'),
                          },
                          {
                            id: 'status-maintenance',
                            label: t('queue.roomSetMaintenanceOpt'),
                            icon: <Wrench className="w-4 h-4 text-rose-600" />,
                            onSelect: () => handleQuickStatus(room, 'maintenance'),
                          },
                          {
                            id: 'edit-room',
                            label: t('queue.roomEditStation'),
                            icon: <Edit2 className="w-4 h-4 text-slate-600" />,
                            onSelect: () => handleOpenEdit(room),
                          },
                          {
                            id: 'delete-room',
                            label: t('queue.roomDeleteStation'),
                            icon: <Trash2 className="w-4 h-4 text-red-500" />,
                            tone: 'danger',
                            onSelect: () => handleOpenDelete(room),
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Card Body Details (High Density) */}
                  <CardContent className="p-3 space-y-2.5">
                    {/* 1. 空闲待客状态 */}
                    {isAvail && (
                      <div className="space-y-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="w-full text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 shadow-xs h-8 cursor-pointer"
                          onClick={() => {
                            setSeatTarget(room);
                            setSeatGuestName('');
                            setSeatServiceName('');
                            setSeatModalOpen(true);
                          }}
                        >
                          <LogIn className="w-3.5 h-3.5 mr-1" />
                          <span>{t('queue.roomSeatGuest')}</span>
                        </Button>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => handleQuickStatus(room, 'cleaning')}
                            className="flex-1 py-1 px-2 rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 text-[11px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors"
                          >
                            <Sparkles className="w-3 h-3 text-teal-600" />
                            
                            {t('queue.roomToCleaning')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleQuickStatus(room, 'maintenance')}
                            className="flex-1 py-1 px-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 text-[11px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors"
                          >
                            <Wrench className="w-3 h-3 text-rose-600" />
                            
                            {t('queue.roomToMaintenance')}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 2. In Service状态 */}
                    {isInService && session && (
                      <div
                        className="space-y-2 text-xs cursor-pointer"
                        onClick={() => {
                          setSessionDetailRoom(room);
                          setSessionDetailModalOpen(true);
                        }}
                      >
                        {/* 客户与技师 */}
                        <div className="flex items-center justify-between font-bold text-slate-900 bg-white p-1.5 rounded-xl border border-slate-100">
                          <div className="flex items-center gap-1 truncate text-xs">
                            <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="truncate">{session.customerName}</span>
                          </div>
                          <div className="flex items-center gap-1 text-amber-800 shrink-0 font-semibold text-[11px]">
                            <Scissors className="w-3 h-3 text-amber-600" />
                            <span className="truncate">{session.staffNames.join(', ') || t('queue.roomTherapist')}</span>
                          </div>
                        </div>

                        {/* 服务项目与进度 */}
                        <div className="bg-white/80 p-2 rounded-xl border border-slate-100 space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-medium text-slate-900 truncate">
                              {session.serviceName}
                            </span>
                            <span className="font-mono text-slate-500 shrink-0">
                              {session.progressMinutes}/{session.totalMinutes}m
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                isOvertime ? 'bg-red-500' : 'bg-amber-500'
                              }`}
                              style={{ width: `${progressPercent}%` }}
                            />
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            className="flex-1 text-xs font-bold text-amber-900 bg-amber-100 hover:bg-amber-200 border-amber-300 h-7 cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickStatus(room, 'cleaning');
                            }}
                          >
                            <Sparkles className="w-3.5 h-3.5 mr-1 text-amber-700" />
                            <span>{t('queue.roomServiceDoneClean')}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border-emerald-200 h-7 cursor-pointer px-2.5"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickStatus(room, 'available');
                            }}
                          >
                            
                            {t('queue.roomResetAvailable')}
                          </Button>
                        </div>
                      </div>
                    )}

                    {isInService && !session && (
                      <div className="space-y-2">
                        <div className="p-2 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900 font-medium flex items-center justify-between">
                          <span>{t('queue.roomManualInService')}</span>
                          <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">{t('queue.roomOccupied')}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            className="flex-1 text-xs font-bold bg-teal-600 hover:bg-teal-700 text-white h-7 cursor-pointer"
                            onClick={() => handleQuickStatus(room, 'cleaning')}
                          >
                            <Sparkles className="w-3.5 h-3.5 mr-1" />
                            <span>{t('queue.roomToCleaning2')}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="flex-1 text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border-emerald-200 h-7 cursor-pointer"
                            onClick={() => handleQuickStatus(room, 'available')}
                          >
                            <span>{t('queue.roomResetAvailable2')}</span>
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* 3. 打扫消毒状态 */}
                    {isCleaning && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-teal-800 font-semibold flex items-center gap-1">
                          <Sparkles className="w-3 h-3 text-teal-600 animate-spin" />
                          <span>{t('queue.roomCleaningInProgress')}</span>
                        </p>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="w-full text-xs font-bold bg-teal-600 hover:bg-teal-700 text-white border-teal-700 shadow-xs h-8 cursor-pointer"
                          onClick={() => handleQuickStatus(room, 'available')}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                          <span>{t('queue.roomCleaningDone')}</span>
                        </Button>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setSeatTarget(room);
                              setSeatGuestName('');
                              setSeatServiceName('');
                              setSeatModalOpen(true);
                            }}
                            className="flex-1 py-1 px-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 text-[11px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors"
                          >
                            <LogIn className="w-3 h-3 text-emerald-600" />
                            
                            {t('queue.roomSeatDirect')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleQuickStatus(room, 'maintenance')}
                            className="flex-1 py-1 px-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 text-[11px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors"
                          >
                            <Wrench className="w-3 h-3 text-rose-600" />
                            
                            {t('queue.roomToMaintenance2')}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 4. 停用检修状态 */}
                    {isMaint && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-rose-800 font-semibold flex items-center gap-1">
                          <Wrench className="w-3 h-3 text-rose-600" />
                          <span>{t('queue.roomMaintenanceNote')}</span>
                        </p>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="w-full text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white border-rose-700 shadow-xs h-8 cursor-pointer"
                          onClick={() => handleQuickStatus(room, 'available')}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                          <span>{t('queue.roomMaintenanceDone')}</span>
                        </Button>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => handleQuickStatus(room, 'cleaning')}
                            className="flex-1 py-1 px-2 rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 text-[11px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors"
                          >
                            <Sparkles className="w-3 h-3 text-teal-600" />
                            
                            {t('queue.roomToCleaning3')}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 下一场预约预告 */}
                    {upcoming && (
                      <div
                        className={`p-1.5 rounded-lg text-[10px] border flex items-center justify-between gap-1 ${
                          isUpcomingSoon
                            ? 'bg-amber-50 border-amber-200 text-amber-900 font-bold'
                            : 'bg-slate-50 border-slate-200 text-slate-600'
                        }`}
                      >
                        <span className="truncate">
                          ⏰ {formatTimeStr(upcoming.startsAt)}: {upcoming.customerName} ({upcoming.serviceName})
                        </span>
                        <span className="shrink-0 text-[10px] px-1 rounded bg-white border border-slate-200">
                          {upcoming.startsInMinutes === 0 ? t('queue.roomNow') : `${upcoming.startsInMinutes}m`}
                        </span>
                      </div>
                    )}
                  </CardContent>
                </div>
              </Card>
            );
          })}
        </div>
      ) : viewMode === 'timeline' ? (
        /* ─────────────── View 2: Timeline Gantt Ribbon View ─────────────── */
        <Card className="border-slate-200 overflow-hidden rounded-2xl shadow-xs">
          <CardContent className="p-0">
            {/* Timeline Time Header */}
            <div className="bg-slate-50 border-b border-slate-200 p-3 flex items-center justify-between">
              <span className="font-bold text-xs text-slate-700">
                
                {t('queue.roomGanttTitle')}
              </span>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  
                  {t('queue.roomLegendFree')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                  
                  {t('queue.roomLegendBusy')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-teal-500" />
                  
                  {t('queue.roomLegendCleaning')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                  
                  {t('queue.roomLegendMaintenance')}
                </span>
              </div>
            </div>

            {/* Timeline Rows */}
            <div className="divide-y divide-slate-100 overflow-x-auto">
              <div className="min-w-[760px]">
                {/* Hours Scale Header */}
                <div className="flex items-center text-[11px] font-mono text-slate-400 bg-slate-50/50 py-2 px-4 border-b border-slate-100">
                  <div className="w-44 shrink-0 font-sans font-bold text-slate-600">
                    
                    {t('queue.roomColRoom')}
                  </div>
                  <div className="flex-1 grid grid-cols-12 text-center">
                    <span>09:00</span>
                    <span>10:00</span>
                    <span>11:00</span>
                    <span>12:00</span>
                    <span>13:00</span>
                    <span>14:00</span>
                    <span>15:00</span>
                    <span>16:00</span>
                    <span>17:00</span>
                    <span>18:00</span>
                    <span>19:00</span>
                    <span>20:00</span>
                  </div>
                </div>

                {/* Room Rows */}
                {filteredRooms.map((room) => {
                  const slots = room.todaySlots ?? [];
                  const isAvail = room.status === 'available';

                  return (
                    <div
                      key={room.id}
                      className="flex items-center py-3 px-4 hover:bg-slate-50/80 transition-colors"
                    >
                      {/* Left Room Info */}
                      <div className="w-44 shrink-0 pr-2">
                        <div className="flex items-center gap-1.5">
                          <strong className="text-slate-900 text-xs font-bold truncate">
                            {room.name}
                          </strong>
                          {isAvail ? (
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                          ) : room.status === 'in_service' ? (
                            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                          ) : room.status === 'cleaning' ? (
                            <span className="w-2 h-2 rounded-full bg-teal-500 shrink-0" />
                          ) : (
                            <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          {room.type}  {t('queue.roomCapacitySep')} {room.capacity}
                        </p>
                      </div>

                      {/* Right Timeline Canvas (12 hours: 9am to 9pm = 720 mins) */}
                      <div className="flex-1 h-8 bg-slate-100/70 rounded-xl relative overflow-hidden border border-slate-200">
                        {/* Hour Guide Lines */}
                        <div className="absolute inset-0 grid grid-cols-12 pointer-events-none divide-x divide-slate-200/60" />

                        {/* Slots */}
                        {slots.length === 0 ? (
                          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-400 font-medium">
                            
                            {t('queue.roomNoBookingsToday')}
                          </div>
                        ) : (
                          slots.map((slot) => {
                            try {
                              const start = new Date(slot.startsAt);
                              const end = new Date(slot.endsAt);
                              const startMin =
                                start.getHours() * 60 + start.getMinutes() - 9 * 60;
                              const durationMin = Math.max(
                                20,
                                Math.round((end.getTime() - start.getTime()) / 60000),
                              );

                              // 720 分钟对应 100%
                              const leftPercent = Math.max(
                                0,
                                Math.min(100, (startMin / 720) * 100),
                              );
                              const widthPercent = Math.min(
                                100 - leftPercent,
                                (durationMin / 720) * 100,
                              );

                              return (
                                <div
                                  key={slot.id}
                                  className="absolute top-1 bottom-1 rounded-lg bg-amber-500 text-white text-[10px] font-bold px-1.5 flex items-center overflow-hidden shadow-xs hover:bg-amber-600 cursor-pointer transition-all z-10"
                                  style={{
                                    left: `${leftPercent}%`,
                                    width: `${Math.max(4, widthPercent)}%`,
                                  }}
                                  title={t('queue.roomGanttTooltip', { p0: slot.customerName, p1: slot.serviceName, p2: formatTimeStr(slot.startsAt), p3: formatTimeStr(slot.endsAt), p4: slot.staffName })}
                                >
                                  <span className="truncate">{slot.customerName}</span>
                                </div>
                              );
                            } catch {
                              return null;
                            }
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* ─────────────── View 3: Compact List View ─────────────── */
        <Card className="border-slate-200 overflow-hidden rounded-2xl shadow-xs">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase text-[11px]">
                  <tr>
                    <th className="p-3.5 pl-5">{t('queue.roomColRoom2')}</th>
                    <th className="p-3.5">{t('queue.roomColType')}</th>
                    <th className="p-3.5">{t('queue.roomColCapacity')}</th>
                    <th className="p-3.5">{t('queue.roomColStatus')}</th>
                    <th className="p-3.5">{t('queue.roomColInService')}</th>
                    <th className="p-3.5">{t('queue.roomColNextBooking')}</th>
                    <th className="p-3.5 pr-5 text-right">{t('queue.roomColActions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRooms.map((room) => {
                    const session = room.currentSession;
                    const upcoming = room.upcomingSession;

                    return (
                      <tr key={room.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="p-3.5 pl-5 font-bold text-slate-900">
                          <div className="flex items-center gap-1.5">
                            <span>{room.name}</span>
                            <button
                              onClick={() => handleOpenEdit(room)}
                              className="text-slate-400 hover:text-slate-700 p-0.5 rounded"
                              title={t('queue.roomEditStation2')}
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                        <td className="p-3.5 text-slate-600">{room.type}</td>
                        <td className="p-3.5 text-slate-600 font-mono">{room.capacity}  {t('queue.roomPeopleUnit2')}</td>
                        <td className="p-3.5">
                          <select
                            value={room.status}
                            onChange={(e) => handleQuickStatus(room, e.target.value as RoomStatus)}
                            className="text-xs font-bold px-2 py-1 rounded-xl border cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-500/20 transition-all bg-white"
                          >
                            <option value="available">{t('queue.roomListAvailable')}</option>
                            <option value="in_service">🟡 In Service</option>
                            <option value="cleaning">{t('queue.roomListCleaning')}</option>
                            <option value="maintenance">{t('queue.roomListMaintenance')}</option>
                          </select>
                        </td>
                        <td className="p-3.5 text-slate-700">
                          {session ? (
                            <div className="space-y-0.5">
                              <p className="font-bold text-slate-900">
                                {session.customerName} · {session.serviceName}
                              </p>
                              <p className="text-[11px] text-slate-500 font-mono">
                                
                                {t('queue.roomTherapistLabel')} {session.staffNames.join(', ') || '—'}  {t('queue.roomProgressSep')} {session.progressMinutes}/{session.totalMinutes}m
                              </p>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="p-3.5 text-slate-700">
                          {upcoming ? (
                            <div>
                              <p className="font-semibold text-slate-900">
                                {formatTimeStr(upcoming.startsAt)} · {upcoming.customerName}
                              </p>
                              <p className="text-[11px] text-amber-700 font-medium">
                                {upcoming.startsInMinutes}  {t('queue.roomMinutesLater')}
                              </p>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="p-3.5 pr-5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {room.status !== 'available' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-emerald-700 hover:bg-emerald-50 font-bold"
                                onClick={() => handleQuickStatus(room, 'available')}
                              >
                                
                                {t('queue.roomSetFree')}
                              </Button>
                            )}
                            {room.status !== 'in_service' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-amber-700 hover:bg-amber-50 font-bold"
                                onClick={() => handleQuickStatus(room, 'in_service')}
                              >
                                
                                {t('queue.roomSetBusy')}
                              </Button>
                            )}
                            {room.status !== 'cleaning' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-teal-700 hover:bg-teal-50 font-bold"
                                onClick={() => handleQuickStatus(room, 'cleaning')}
                              >
                                
                                {t('queue.roomSetClean')}
                              </Button>
                            )}

                            {/* 更多动作 */}
                            <ActionMenu
                              label={t('queue.roomMoreActions')}
                              items={[
                                {
                                  id: 'edit-room-row',
                                  label: t('queue.roomEditStation3'),
                                  icon: <Edit2 className="w-3.5 h-3.5 text-slate-600" />,
                                  onSelect: () => handleOpenEdit(room),
                                },
                                {
                                  id: 'maint-row',
                                  label: t('queue.roomMarkMaintenance'),
                                  icon: <Wrench className="w-3.5 h-3.5 text-rose-600" />,
                                  onSelect: () => {
                                    setMaintenanceTarget(room);
                                    setMaintenanceNote('');
                                    setMaintenanceModalOpen(true);
                                  },
                                },
                                {
                                  id: 'del-row',
                                  label: t('queue.roomDeleteStation2'),
                                  icon: <Trash2 className="w-3.5 h-3.5 text-red-500" />,
                                  tone: 'danger',
                                  onSelect: () => handleOpenDelete(room),
                                },
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 弹窗部分 (Modals)                                                  */}
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* 1. 新增 / 编辑工位 Modal */}
      <Modal
        isOpen={saveModalOpen}
        onOpenChange={setSaveModalOpen}
        title={editingRoom ? t('queue.roomEditModalTitle', { p0: editingRoom.name }) : t('queue.roomAddModalTitle')}
        footer={
          <div className="flex items-center justify-between w-full">
            <div>
              {editingRoom ? (
                <Button
                  variant="ghost"
                  className="text-xs text-red-600 hover:bg-red-50 hover:text-red-700 font-semibold gap-1"
                  onClick={() => handleOpenDelete(editingRoom)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{t('queue.roomDeleteThis')}</span>
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setSaveModalOpen(false)}>
                {t('cancel') || t('queue.roomCancel')}
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
                onClick={handleSaveResource}
                disabled={saveResourceMutation.isPending}
              >
                {saveResourceMutation.isPending ? t('queue.roomSaving') : t('save') || t('queue.roomSave')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('queue.roomNameLabel')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('queue.roomNamePlaceholder')}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('queue.roomTypeLabel')}
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-500"
              >
                <option value="room">{t('queue.roomTypePrivate')}</option>
                <option value="vip">{t('queue.roomTypeVip')}</option>
                <option value="chair">{t('queue.roomTypeNail')}</option>
                <option value="table">{t('queue.roomTypePedicure')}</option>
                <option value="bed">{t('queue.roomTypeMassage')}</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('queue.roomCapacityLabel')}
              </label>
              <Input
                type="number"
                min="1"
                max="20"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('queue.roomMaxStaffLabel')}
            </label>
            <Input
              type="number"
              min="1"
              max="10"
              value={maxStaff}
              onChange={(e) => setMaxStaff(e.target.value)}
              placeholder={t('queue.roomMaxStaffPlaceholder')}
            />
            <p className="text-[11px] text-slate-400 mt-1">
              
              {t('queue.roomMaxStaffHint')}
            </p>
          </div>
        </div>
      </Modal>

      {/* 2. 删除确认 Modal */}
      <Modal
        isOpen={deleteModalOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteModalOpen(false);
        }}
        size="sm"
        title={t('queue.roomDeleteModalTitle', { p0: deleteTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>
              {t('cancel') || t('queue.roomDeleteCancel')}
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white font-bold"
              onClick={handleConfirmDelete}
              disabled={deleteResourceMutation.isPending}
            >
              {deleteResourceMutation.isPending ? t('queue.roomDeleting') : t('queue.roomDeleteConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-900 flex items-start gap-2.5">
            <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">{t('queue.roomDeleteWarn')}</p>
              <p className="text-[11px] text-red-700 mt-1">
                
                {t('queue.roomDeletePrefix')}<strong>{deleteTarget?.name}</strong>{t('queue.roomDeleteSuffix')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="force-delete-chk"
              checked={forceDelete}
              onChange={(e) => setForceDelete(e.target.checked)}
              className="rounded border-slate-300 text-red-600 focus:ring-red-500 w-4 h-4"
            />
            <label
              htmlFor="force-delete-chk"
              className="text-xs font-semibold text-slate-700 cursor-pointer"
            >
              
              {t('queue.roomForceDelete')}
            </label>
          </div>
        </div>
      </Modal>

      {/* 3. 安排入座快捷 Modal */}
      <Modal
        isOpen={seatModalOpen}
        onOpenChange={(open) => {
          if (!open) setSeatModalOpen(false);
        }}
        size="sm"
        title={t('queue.roomSeatModalTitle', { p0: seatTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setSeatModalOpen(false)}>
              {t('cancel') || t('queue.roomSeatCancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
              onClick={handleConfirmSeat}
              disabled={setStatusMutation.isPending}
            >
              
              {t('queue.roomSeatConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900">
            <p className="font-bold">{t('queue.roomSeatIntro')}{seatTarget?.name}</p>
            <p className="text-[11px] mt-0.5 text-emerald-700">
              
              {t('queue.roomSeatCapacity')} {seatTarget?.capacity}  {t('queue.roomSeatCapacitySuffix')}
            </p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('queue.roomSeatGuestName')}
            </label>
            <Input
              value={seatGuestName}
              onChange={(e) => setSeatGuestName(e.target.value)}
              placeholder={t('queue.roomSeatGuestPlaceholder')}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('queue.roomSeatServiceNote')}
            </label>
            <Input
              value={seatServiceName}
              onChange={(e) => setSeatServiceName(e.target.value)}
              placeholder={t('queue.roomSeatServicePlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 4. 停用检修说明 Modal */}
      <Modal
        isOpen={maintenanceModalOpen}
        onOpenChange={(open) => {
          if (!open) setMaintenanceModalOpen(false);
        }}
        size="sm"
        title={t('queue.roomMaintModalTitle', { p0: maintenanceTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setMaintenanceModalOpen(false)}>
              {t('cancel') || t('queue.roomMaintCancel')}
            </Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700 text-white font-bold"
              onClick={handleConfirmMaintenance}
              disabled={setStatusMutation.isPending}
            >
              
              {t('queue.roomMaintConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-900">
            <p className="font-bold">{t('queue.roomMaintWarn')}</p>
            <p className="text-[11px] mt-0.5 text-rose-700">
              
              {t('queue.roomMaintWarnDesc')}
            </p>
          </div>

          {/* 快捷原因选项 */}
          <div>
            <span className="block font-bold text-slate-700 uppercase mb-1.5">
              
              {t('queue.roomMaintPresets')}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {MAINTENANCE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setMaintenanceNote(preset)}
                  className={`text-[11px] px-2 py-1 rounded-lg border font-medium transition-all ${
                    maintenanceNote === preset
                      ? 'bg-rose-600 text-white border-rose-600 font-bold'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('queue.roomMaintNote')}
            </label>
            <Input
              value={maintenanceNote}
              onChange={(e) => setMaintenanceNote(e.target.value)}
              placeholder={t('queue.roomMaintNotePlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 5. 正在In Service详情与快速转打扫 Modal */}
      <Modal
        isOpen={sessionDetailModalOpen}
        onOpenChange={(open) => {
          if (!open) setSessionDetailModalOpen(false);
        }}
        size="sm"
        title={t('queue.roomServiceModalTitle', { p0: sessionDetailRoom?.name ?? '' })}
        footer={
          <div className="flex justify-between items-center w-full">
            <Button
              variant="secondary"
              className="text-xs font-bold text-emerald-700 border-emerald-300 hover:bg-emerald-50"
              onClick={() => {
                if (sessionDetailRoom) handleQuickStatus(sessionDetailRoom, 'available');
                setSessionDetailModalOpen(false);
              }}
            >
              
              {t('queue.roomSetFreeDirect')}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => setSessionDetailModalOpen(false)}
              >
                
                {t('queue.roomServiceClose')}
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                onClick={() => {
                  if (sessionDetailRoom) handleQuickStatus(sessionDetailRoom, 'cleaning');
                  setSessionDetailModalOpen(false);
                }}
              >
                <Sparkles className="w-3.5 h-3.5 mr-1" />
                <span>{t('queue.roomEndAndClean')}</span>
              </Button>
            </div>
          </div>
        }
      >
        {sessionDetailRoom?.currentSession ? (
          <div className="space-y-3.5 py-1 text-xs">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
              <div className="flex justify-between items-center font-bold">
                <span className="text-slate-500">{t('queue.roomGuestName')}</span>
                <span className="text-slate-900 text-sm">{sessionDetailRoom.currentSession.customerName}</span>
              </div>
              <div className="flex justify-between items-center font-bold">
                <span className="text-slate-500">{t('queue.roomServingStaff')}</span>
                <span className="text-amber-800">{sessionDetailRoom.currentSession.staffNames.join(', ') || '—'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-bold">{t('queue.roomServiceItem')}</span>
                <span className="text-slate-900 font-semibold">{sessionDetailRoom.currentSession.serviceName}</span>
              </div>
              <div className="flex justify-between items-center text-slate-500">
                <span>{t('queue.roomStartTime')}</span>
                <span className="font-mono text-slate-700">{formatTimeStr(sessionDetailRoom.currentSession.startedAt)}</span>
              </div>
              <div className="flex justify-between items-center text-slate-500">
                <span>{t('queue.roomExpectedEnd')}</span>
                <span className="font-mono text-slate-700">{formatTimeStr(sessionDetailRoom.currentSession.estimatedEndAt)}</span>
              </div>
            </div>

            <div className="p-3 bg-amber-50/60 border border-amber-200 rounded-xl space-y-1.5">
              <div className="flex justify-between font-bold text-amber-950 text-xs">
                <span>{t('queue.roomProgress')}</span>
                <span>
                  {sessionDetailRoom.currentSession.progressMinutes} / {sessionDetailRoom.currentSession.totalMinutes}  {t('queue.roomMinutes')}
                </span>
              </div>
              <div className="w-full h-2 bg-amber-200/80 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (sessionDetailRoom.currentSession.progressMinutes /
                          Math.max(1, sessionDetailRoom.currentSession.totalMinutes)) *
                          100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="py-4 text-center text-slate-400">
            
            {t('queue.roomNoSessionInfo')}
          </div>
        )}
      </Modal>
    </div>
  );
}

export function Rooms() {
  return (
    <ErrorBoundary fallbackTitleKey="rooms">
      <RoomsContent />
    </ErrorBoundary>
  );
}
