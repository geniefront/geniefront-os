import { useState, useEffect } from "react";
import { useErrorMessage } from '@/lib/errorMessage';
import { useLanguage } from "@/LanguageContext";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal, ConfirmDialog } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageLoading, PageError } from "@/components/ui/QueryState";
import {
  Tablet,
  QrCode,
  RefreshCw,
  CheckCircle2,
  ShieldCheck,
  Battery,
  Wifi,
  FileCheck2,
  MonitorSmartphone,
  Eye,
  Trash2,
  RotateCcw,
  Plus,
} from "lucide-react";
import { toast } from "@heroui/react";
import {
  useCreatePairingSession, useHardwareDevicesQuery, usePairingStatus,
  useQueueDeviceCommand, useRevokeDevice, type HardwareDevice,
} from "@/features/pairing/api";
import { useDeskSettingsQuery } from '@/features/settings/api';

export function HardwareServer({ embedded = false }: { embedded?: boolean } = {}) {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const createSessionMut = useCreatePairingSession();
  const devicesQuery = useHardwareDevicesQuery();
  const queueCommandMutation = useQueueDeviceCommand();
  const revokeDeviceMutation = useRevokeDevice();
  const settingsQuery = useDeskSettingsQuery();

  // 配对状态
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [pairingRole, setPairingRole] = useState<"intake_kiosk" | "customer_display">("intake_kiosk");

  // 监听配对状态
  const pairingStatusQ = usePairingStatus(sessionCode);

  // 二次确认弹窗状态
  const [confirmRegenPinOpen, setConfirmRegenPinOpen] = useState(false);
  const [resettingDevice, setResettingDevice] = useState<HardwareDevice | null>(null);
  const [unpairingDevice, setUnpairingDevice] = useState<HardwareDevice | null>(null);
  const devices = devicesQuery.data?.devices.filter((device) => device.state !== 'revoked') ?? [];

  useEffect(() => {
    if (pairingStatusQ.data?.status === 'paired') void devicesQuery.refetch();
  }, [pairingStatusQ.data?.status]);

  // 平板界面实时交互预览 Simulator Modal
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewDeviceRole, setPreviewDeviceRole] = useState<"intake_kiosk" | "customer_display">("intake_kiosk");
  const [simStep, setSimStep] = useState<"welcome" | "phone" | "questions" | "sign" | "success">("welcome");

  const handleRegenerateCode = async () => {
    try {
      const res = await createSessionMut.mutateAsync(pairingRole === 'intake_kiosk' ? 'kiosk' : 'customer-facing');
      if (res?.code) {
        setSessionCode(res.code);
        toast.success(t('settings.hwPinRegenerated'));
      }
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handlePingDevice = async (device: HardwareDevice) => {
    await queueCommandMutation.mutateAsync({ deviceId: device.deviceId, kind: 'wake' });
    toast.success(t('settings.hwCommandQueued', { p0: device.label }));
  };

  const handleResetKiosk = async (device: HardwareDevice) => {
    await queueCommandMutation.mutateAsync({ deviceId: device.deviceId, kind: 'reset_home' });
    toast.success(t('settings.hwCommandQueued', { p0: device.label }));
  };

  const handleUnpairDevice = async (device: HardwareDevice) => {
    await revokeDeviceMutation.mutateAsync(device.deviceId);
    toast.success(t('settings.hwUnpaired', { p0: device.label }));
  };

  if ((devicesQuery.isLoading || settingsQuery.isLoading) && !devicesQuery.data && !settingsQuery.data) {
    return <PageLoading layout="detail" title={t('settings.hwLoading')} description={t('settings.hwLoadingDesc')} />;
  }

  if ((devicesQuery.isError || settingsQuery.isError) && !devicesQuery.data && !settingsQuery.data) {
    return (
      <PageError
        title={t('settings.hwLoadError')}
        error={pairingStatusQ.error}
        onRetry={() => {
          void Promise.all([devicesQuery.refetch(), settingsQuery.refetch()]);
        }}
      />
    );
  }

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 pb-20 max-w-7xl mx-auto"}>
      {!embedded && <PageHeader
        title={
          <span className="flex items-center gap-2 text-xl font-bold">
            <Tablet className="w-5 h-5 text-teal-600" />
            
            {t('settings.hwTitle')}
          </span>
        }
        description={t('settings.hwDesc')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPreviewDeviceRole("intake_kiosk");
                setSimStep("welcome");
                setPreviewModalOpen(true);
              }}
              className="gap-1.5 text-xs font-bold"
            >
              <Eye className="w-3.5 h-3.5 text-teal-600" />
              
              {t('settings.hwPreviewKiosk')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold text-xs shadow-sm"
              size="sm"
              onClick={() => setConfirmRegenPinOpen(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              
              {t('settings.hwPairNew')}
            </Button>
          </div>
        }
      />}

      {/* 顶部设备网络健康状态 */}
      <div className="p-4 rounded-2xl bg-gradient-to-r from-teal-900 to-slate-900 text-white shadow-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-teal-500/20 border border-teal-400/30 flex items-center justify-center">
            <Tablet className="w-5 h-5 text-teal-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm">{t('settings.hwFleetTitle')}</h3>
              <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-400/30 text-[10px]">
                
                {devices.filter((device) => device.state === 'online').length} / {devices.length} {t('settings.hwOnline')}
              </Badge>
            </div>
            <p className="text-xs text-teal-100/80 mt-0.5">
              
              {t('settings.hwFleetDesc')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono text-teal-200">
          <span className="flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" /> {t('settings.hwHeartbeat')} API
          </span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-teal-300" />  {t('settings.hwKioskLocked')}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧 2 列：已配对终端列表 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 在线设备卡片列表 */}
          <Card className="p-5 border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <Tablet className="w-4 h-4 text-teal-600" />
                
                {t('settings.hwPairedTablets')}{devices.length})
              </h3>
              <span className="text-xs text-slate-400">{t('settings.hwStandbyNote')}</span>
            </div>

            <div className="space-y-3">
              {devices.map((dev) => (
                <div
                  key={dev.deviceId}
                  className="p-4 rounded-2xl border border-slate-200 bg-white hover:border-teal-300 hover:shadow-sm transition-all space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700">
                        {dev.terminalType === "kiosk" ? (
                          <FileCheck2 className="w-5 h-5 text-teal-600" />
                        ) : (
                          <MonitorSmartphone className="w-5 h-5 text-blue-600" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-slate-900 text-xs sm:text-sm">{dev.label}</h4>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${dev.state === 'online' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${dev.state === 'online' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                            
                            {dev.state === 'online' ? t('settings.hwOnline') : t('settings.hwOffline')}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                          {dev.model ?? '—'} · IP: {dev.ipAddress ?? '—'} · App {dev.appVersion ?? '—'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      <Button
                        isPending={queueCommandMutation.isPending}
                        size="sm"
                        variant="secondary"
                        className="text-xs h-8 px-2.5 text-slate-700"
                        disabled={queueCommandMutation.isPending}
                        onClick={() => void handlePingDevice(dev).catch((err) => toast.danger(errorMessage(err)))}
                      >
                        
                        {t('settings.hwWake')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-xs h-8 px-2.5 text-slate-700"
                        onClick={() => setResettingDevice(dev)}
                      >
                        <RotateCcw className="w-3 h-3 mr-1 text-slate-500" />
                        
                        {t('settings.hwResetHome')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-xs h-8 px-2 text-red-600 hover:bg-red-50"
                        onClick={() => setUnpairingDevice(dev)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-[11px]">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Battery className="w-3.5 h-3.5 text-emerald-600" />
                      <span>{t('settings.hwBattery')} {dev.batteryLevel === null ? '—' : `${dev.batteryLevel}%`}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Wifi className="w-3.5 h-3.5 text-teal-600" />
                      <span>WiFi: {dev.wifiSignalDbm === null ? '—' : `${dev.wifiSignalDbm} dBm`}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-600 justify-end">
                      <span>{t('settings.hwHeartbeat')} {dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : '—'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

        </div>

        {/* 右侧 1 列：快速配对与入网引导 */}
        <div className="space-y-4">
          <Card className="p-5 border-teal-200 bg-teal-50/50 shadow-sm space-y-4 text-xs">
            <div className="flex items-center gap-2 font-bold text-teal-950 text-sm">
              <QrCode className="w-4 h-4 text-teal-600" />
              
              {t('settings.hwPairTitle')}
            </div>

            <p className="text-slate-600 leading-relaxed">
              
              {t('settings.hwPairDesc')}
            </p>

            {/* 配对模式选择 */}
            <div className="space-y-1.5">
              <label className="font-bold text-slate-700">{t('settings.hwAssignRole')}</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setPairingRole("intake_kiosk")}
                  className={`p-2 rounded-xl border text-center font-bold transition-all ${
                    pairingRole === "intake_kiosk"
                      ? "bg-teal-600 text-white border-teal-600 shadow-sm"
                      : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  
                  {t('settings.hwRoleIntake')}
                </button>
                <button
                  onClick={() => setPairingRole("customer_display")}
                  className={`p-2 rounded-xl border text-center font-bold transition-all ${
                    pairingRole === "customer_display"
                      ? "bg-teal-600 text-white border-teal-600 shadow-sm"
                      : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  
                  {t('settings.hwRoleDisplay')}
                </button>
              </div>
            </div>

            {/* 6 位配对码大字展示 */}
            <div className="p-4 rounded-2xl bg-white border border-teal-200 text-center space-y-1 shadow-sm">
              <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                6-Digit Pairing PIN
              </span>
              <div className="text-3xl font-black font-mono text-teal-700 tracking-widest">
                {sessionCode ?? '—'}
              </div>
              <p className="text-[10px] text-slate-400">{t('settings.hwPinValidity')}</p>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmRegenPinOpen(true)}
              className="w-full text-xs font-bold text-slate-700 h-9 gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate PIN
            </Button>

            <div className="p-3 rounded-xl bg-white/80 border border-teal-200 text-[11px] text-slate-600 space-y-1">
              <span className="font-bold text-slate-800">{t('settings.hwGuidedAccessTitle')}</span>
              <p className="leading-relaxed">
                
                {t('settings.hwGuidedAccessDesc')}
              </p>
            </div>
          </Card>
        </div>
      </div>

      {/* 平板真机界面交互模拟弹窗 Simulator Modal */}
      <Modal
        isOpen={previewModalOpen}
        onOpenChange={setPreviewModalOpen}
        size="lg"
        title={
          <div className="flex items-center gap-2">
            <Tablet className="w-5 h-5 text-teal-600" />
            <span>{t('settings.hwSimTitle')}</span>
            <Badge className="bg-teal-100 text-teal-900 border-teal-300 text-[10px]">
              {previewDeviceRole === "intake_kiosk" ? t('settings.hwSimIntakeMode') : t('settings.hwSimDisplayMode')}
            </Badge>
          </div>
        }
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setPreviewModalOpen(false)}>
              
              {t('settings.hwSimClose')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          {/* 模拟 iPad 硬件边框 */}
          <div className="bg-slate-900 p-4 rounded-3xl shadow-2xl border-4 border-slate-700 max-w-lg mx-auto">
            {/* iPad 屏幕内容 */}
            <div className="bg-white rounded-2xl p-6 min-h-[380px] flex flex-col justify-between text-slate-900 space-y-4">
              {simStep === "welcome" && (
                <div className="text-center py-6 space-y-4 flex-1 flex flex-col justify-center items-center">
                  <div className="w-14 h-14 rounded-2xl bg-teal-600 text-white font-bold flex items-center justify-center text-xl shadow-lg">
                    {(settingsQuery.data?.location.name || 'GF').slice(0, 6)}
                  </div>
                  <h2 className="text-lg font-black text-slate-900">
                    
                    {t('settings.hwSimWelcomeStore', { p0: settingsQuery.data?.location.name || 'GenieFront' })}
                  </h2>
                  <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                    
                    {t('settings.hwSimWelcomeDesc')}
                  </p>
                  <Button
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-md gap-2"
                    onClick={() => setSimStep("phone")}
                  >
                    <span>{t('settings.hwSimCheckIn')}</span>
                  </Button>
                </div>
              )}

              {simStep === "phone" && (
                <div className="space-y-4 py-2">
                  <div className="text-center">
                    <h3 className="font-bold text-sm text-slate-900">{t('settings.hwSimPhonePrompt')}</h3>
                    <p className="text-[11px] text-slate-400">{t('settings.hwSimPhoneHint')}</p>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center font-mono font-bold text-lg text-slate-800">
                    +1 (212) 555-0192
                  </div>

                  <div className="grid grid-cols-3 gap-2 max-w-xs mx-auto text-xs font-mono font-bold">
                    {["1", "2", "3", "4", "5", "6", "7", "8", "9", t('settings.hwSimClear'), "0", t('settings.hwSimConfirm')].map((k) => (
                      <button
                        key={k}
                        onClick={() => {
                          if (k === t('settings.hwSimConfirm')) setSimStep("questions");
                        }}
                        className={`p-2.5 rounded-xl border transition-all ${
                            k === t('settings.hwSimConfirm')
                            ? "bg-teal-600 text-white border-teal-600 font-sans"
                            : "bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {simStep === "questions" && (
                <div className="space-y-3 py-1 text-xs">
                  <div className="border-b border-slate-100 pb-2">
                    <h3 className="font-bold text-slate-900">{t('settings.hwSimPressureTitle')}</h3>
                    <p className="text-[10px] text-slate-400">{t('settings.hwSimBooking')}</p>
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">{t('settings.hwSimPressureLabel')}</label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[t('settings.hwSimPressureLight'), t('settings.hwSimPressureMedium'), t('settings.hwSimPressureFirm')].map((p, idx) => (
                        <button
                          key={p}
                          className={`p-2 rounded-lg border text-[10px] font-bold ${
                            idx === 2 ? "bg-teal-50 border-teal-600 text-teal-900" : "border-slate-200 text-slate-600"
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">{t('settings.hwSimFocusLabel')}</label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[t('settings.hwSimAreaNeck'), t('settings.hwSimAreaBack'), t('settings.hwSimAreaArm')].map((p, idx) => (
                        <span key={p} className="p-1.5 rounded-lg bg-teal-50 text-teal-900 font-semibold border border-teal-200 text-[10px] text-center">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>

                  <Button
                    className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-9"
                    onClick={() => setSimStep("sign")}
                  >
                    
                    {t('settings.hwSimNextWaiver')}
                  </Button>
                </div>
              )}

              {simStep === "sign" && (
                <div className="space-y-3 py-1 text-xs">
                  <div className="border-b border-slate-100 pb-2">
                    <h3 className="font-bold text-slate-900">{t('settings.hwSimWaiverTitle')}</h3>
                    <p className="text-[10px] text-slate-500">
                      
                      {t('settings.hwSimWaiverBody')}
                    </p>
                  </div>

                  {/* 模拟手写签名板 */}
                  <div className="h-28 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/60 p-3 flex flex-col justify-between">
                    <span className="text-[10px] text-slate-400">{t('settings.hwSimSignHere')}</span>
                    <div className="text-right font-mono text-xs text-teal-700 font-bold italic">
                      ✍️ Emily Chen (2026-08-27)
                    </div>
                  </div>

                  <Button
                    className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-9"
                    onClick={() => setSimStep("success")}
                  >
                    
                    {t('settings.hwSimSubmit')}
                  </Button>
                </div>
              )}

              {simStep === "success" && (
                <div className="text-center py-8 space-y-3 flex-1 flex flex-col justify-center items-center">
                  <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                    <CheckCircle2 className="w-7 h-7" />
                  </div>
                  <h3 className="font-bold text-base text-slate-900">{t('settings.hwSimDone')}</h3>
                  <p className="text-xs text-slate-500 max-w-xs">
                    
                    {t('settings.hwSimDoneDesc')}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="text-xs mt-2"
                    onClick={() => setSimStep("welcome")}
                  >
                    
                    {t('settings.hwSimReturn')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* Regenerate PIN二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmRegenPinOpen}
        onOpenChange={setConfirmRegenPinOpen}
        title={t('settings.hwRegenConfirmTitle')}
        description={t('settings.hwRegenConfirmBody')}
        confirmLabel={t('settings.hwRegenConfirmAction')}
        onConfirm={handleRegenerateCode}
      />

      {/* 终端复位首页二次确认弹窗 */}
      <ConfirmDialog
        isOpen={resettingDevice !== null}
        onOpenChange={(open) => {
          if (!open) setResettingDevice(null);
        }}
        title={t('settings.hwResetConfirmTitle', { p0: resettingDevice?.label ?? '' })}
        description={t('settings.hwResetConfirmBody')}
        confirmLabel={t('settings.hwResetConfirmAction')}
        onConfirm={async () => {
          if (resettingDevice) {
            try {
              await handleResetKiosk(resettingDevice);
              setResettingDevice(null);
            } catch (err: any) {
              toast.danger(errorMessage(err));
            }
          }
        }}
      />

      {/* 解除配对二次确认弹窗 */}
      <ConfirmDialog
        isOpen={unpairingDevice !== null}
        onOpenChange={(open) => {
          if (!open) setUnpairingDevice(null);
        }}
        tone="danger"
        title={t('settings.hwUnpairConfirmTitle', { p0: unpairingDevice?.label ?? '' })}
        description={t('settings.hwUnpairConfirmBody')}
        confirmLabel={t('settings.hwUnpairConfirmAction')}
        onConfirm={async () => {
          if (unpairingDevice) {
            try {
              await handleUnpairDevice(unpairingDevice);
              setUnpairingDevice(null);
            } catch (err: any) {
              toast.danger(errorMessage(err));
            }
          }
        }}
      />
    </div>
  );
}
