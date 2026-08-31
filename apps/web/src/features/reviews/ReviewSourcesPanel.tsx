/**
 * 外部口碑采集的设置面板（05-AI-INTEGRATION §8）。
 *
 * 三块，顺序就是老板要做的三件事：
 *   1. 填标识（Google 地图链接或 Place ID、Yelp Business ID）
 *   2. 当场同步一次，看抓回来的是不是自己的店
 *   3. 看同步记录 —— 之后所有「怎么没有新评价」的问题都在这里回答
 *
 * ⚠️ 第 3 块不是可有可无的日志页。抓取失败在口碑页面上只表现为
 * 「最近没有新评价」，与真的没人写评价**完全无法区分**；没有这份记录，
 * 一个坏掉的采集可以安静地坏上几个月。
 */
import { useEffect, useState } from 'react';
import { toast } from '@heroui/react';
import { AlertTriangle, RefreshCw, Star } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import { useCan } from '@/lib/permissions';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/Modal';
import {
  useReviewSourcesQuery, useReviewSyncRunsQuery, useRunReviewSync, useSaveReviewSources,
} from './api';
import type { ManualSyncResponse, ReviewSyncRun, SyncState } from './types';

/**
 * 状态 → 文案。
 *
 * 前四种都是「看起来什么都没发生」的状态，不说清楚老板会以为系统坏了，
 * 或者更糟 —— 以为一切正常。其余三种由旁边的条数与徽标自己说明。
 */
const SYNC_STATE_KEY: Record<SyncState, string> = {
  not_configured: 'reviews.stateNotConfigured',
  disabled: 'reviews.stateDisabled',
  throttled: 'reviews.stateThrottled',
  timed_out: 'reviews.stateTimedOut',
  started: 'reviews.syncStillRunning',
  running: 'reviews.syncStillRunning',
  ingested: 'reviews.statusDone',
  failed: 'reviews.statusFailed',
};

/** 空输入等于「清空这一项」，而不是「不动它」—— 两者在命令契约里是分开的 */
const orNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** 毫分 → 展示用的美元字符串。整数分再转，不在中间落浮点 */
function formatCost(millicents: number): string {
  const cents = Math.round(millicents / 1000);
  return `$${(cents / 100).toFixed(2)}`;
}

function StatusBadge({ status }: { status: ReviewSyncRun['status'] }) {
  const { t } = useLanguage();
  if (status === 'done') {
    return <Badge variant="success" className="text-[10px] font-bold">{t('reviews.statusDone')}</Badge>;
  }
  if (status === 'failed') {
    return <Badge variant="error" className="text-[10px] font-bold">{t('reviews.statusFailed')}</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] font-bold">{t('reviews.statusRunning')}</Badge>;
}

export function ReviewSourcesPanel() {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();

  /*
   * ⚠️ 设置页对 `staff.manage` 也开放，但采集配置与同步记录在服务端要求
   * `settings.manage`。不在这里挡住的话，店长打开这一页看到的是两条
   * 失败的请求 —— 权限不足被显示成「系统坏了」。
   */
  const canManage = useCan('settings.manage');
  const sourcesQ = useReviewSourcesQuery({ enabled: canManage });
  const runsQ = useReviewSyncRunsQuery({ enabled: canManage });
  const save = useSaveReviewSources();
  const sync = useRunReviewSync();

  const [mapsUrl, setMapsUrl] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [yelpId, setYelpId] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<ManualSyncResponse | null>(null);

  // 服务端的值是真相；本地状态只是编辑缓冲区
  useEffect(() => {
    if (!sourcesQ.data) return;
    setMapsUrl(sourcesQ.data.googleMapsUrl ?? '');
    setPlaceId(sourcesQ.data.googlePlaceId ?? '');
    setYelpId(sourcesQ.data.yelpBusinessId ?? '');
  }, [sourcesQ.data]);

  const handleSave = async () => {
    try {
      await save.mutateAsync({
        googleMapsUrl: orNull(mapsUrl),
        googlePlaceId: orNull(placeId),
        yelpBusinessId: orNull(yelpId),
      });
      toast.success(t('reviews.saved'));
    } catch (err) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSync = async () => {
    try {
      const result = await sync.mutateAsync({});
      setLastResult(result);

      /*
       * 结果分三种，必须分开说：
       *   抓到新评价 · 抓完了但没有新评价（常态）· 还在跑（抓取是异步的）
       * 混成一句「同步完成」的话，最需要区分的那两种就再也分不开了。
       */
      const inserted = result.sync.reduce((sum, item) => sum + item.inserted, 0);
      const fetched = result.sync.reduce((sum, item) => sum + item.fetched, 0);
      if (result.sync.some((item) => item.state === 'running' || item.state === 'started')) {
        toast.success(t('reviews.syncStillRunning'));
      } else if (inserted > 0) {
        toast.success(t('reviews.syncResult', { p0: fetched, p1: inserted }));
      } else {
        toast.success(t('reviews.syncNothingNew'));
      }
    } catch (err) {
      toast.danger(errorMessage(err));
    }
  };

  const sources = sourcesQ.data;
  const runs = runsQ.data ?? [];

  if (!canManage) {
    return <EmptyState icon={<Star />} title={t('settings.stAccessDenied')} />;
  }

  return (
    <div className="space-y-6">
      {/* ── 1. 平台标识 ─────────────────────────────────────────────────── */}
      <Card className="p-6 space-y-5 rounded-2xl border-slate-200">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-xl bg-amber-50 text-amber-600">
              <Star className="w-4 h-4" />
            </div>
            <h3 className="text-base font-black text-slate-900">{t('reviews.title')}</h3>
          </div>
          <p className="text-xs text-slate-500">{t('reviews.desc')}</p>
        </div>

        {/* Google */}
        <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/60 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800">{t('reviews.googleTitle')}</span>
            <Badge
              variant={sources?.googleReady ? 'success' : 'outline'}
              className="text-[10px] font-bold"
            >
              {sources?.googleReady ? t('reviews.ready') : t('reviews.notReady')}
            </Badge>
          </div>
          <p className="text-[11px] text-slate-500">{t('reviews.googleDesc')}</p>

          <label className="block text-[11px] font-bold text-slate-700">
            {t('reviews.mapsUrlLabel')}
          </label>
          <Input
            value={mapsUrl}
            onChange={(event) => setMapsUrl(event.target.value)}
            placeholder="https://maps.app.goo.gl/…"
            className="text-xs font-mono"
          />
          <p className="text-[11px] text-slate-500">{t('reviews.mapsUrlHint')}</p>

          <label className="block text-[11px] font-bold text-slate-700 pt-1">
            {t('reviews.placeIdLabel')}
          </label>
          <Input
            value={placeId}
            onChange={(event) => setPlaceId(event.target.value)}
            placeholder="ChIJ…"
            className="text-xs font-mono"
          />
        </div>

        {/* Yelp */}
        <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/60 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800">{t('reviews.yelpTitle')}</span>
            <Badge
              variant={sources?.yelpReady ? 'success' : 'outline'}
              className="text-[10px] font-bold"
            >
              {sources?.yelpReady ? t('reviews.ready') : t('reviews.notReady')}
            </Badge>
          </div>
          <p className="text-[11px] text-slate-500">{t('reviews.yelpDesc')}</p>

          <label className="block text-[11px] font-bold text-slate-700">
            {t('reviews.yelpIdLabel')}
          </label>
          <Input
            value={yelpId}
            onChange={(event) => setYelpId(event.target.value)}
            placeholder="lucky-nails-boston"
            className="text-xs font-mono"
          />
          <p className="text-[11px] text-slate-500">{t('reviews.yelpIdHint')}</p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-slate-500">{t('reviews.clearHint')}</p>
          <Button
            onPress={() => void handleSave()}
            disabled={save.isPending}
            className="shrink-0 bg-teal-600 text-white font-bold text-xs"
          >
            {t('reviews.save')}
          </Button>
        </div>
      </Card>

      {/* ── 2. 手动同步 ─────────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4 rounded-2xl border-slate-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-black text-slate-900">{t('reviews.syncTitle')}</h3>
            <p className="text-xs text-slate-500">{t('reviews.syncDesc')}</p>
          </div>
          <Button
            onPress={() => setConfirmOpen(true)}
            disabled={sync.isPending || !(sources?.googleReady || sources?.yelpReady)}
            className="shrink-0 bg-slate-900 text-white font-bold text-xs flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${sync.isPending ? 'animate-spin' : ''}`} />
            <span>{sync.isPending ? t('reviews.syncing') : t('reviews.syncButton')}</span>
          </Button>
        </div>

        {/* 上一次手动同步的逐平台结果。它是「我刚才点的那一下发生了什么」的答案 */}
        {lastResult && (
          <div className="space-y-2">
            {lastResult.sync.map((item) => (
              <div
                key={item.platform}
                className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 bg-slate-50 text-xs"
              >
                <span className="font-bold text-slate-800 uppercase">{item.platform}</span>
                <span className="text-slate-600 text-right">
                  {t(SYNC_STATE_KEY[item.state])}
                  {item.state === 'ingested' && (
                    <span className="ml-2 font-mono text-slate-500">
                      {t('reviews.syncResult', { p0: item.fetched, p1: item.inserted })}
                    </span>
                  )}
                </span>
              </div>
            ))}
            {lastResult.analysis && lastResult.analysis.analyzed > 0 && (
              <p className="text-[11px] text-purple-800 font-medium">
                {t('reviews.analysisResult', { p0: lastResult.analysis.analyzed })}
              </p>
            )}
          </div>
        )}
      </Card>

      {/* ── 3. 同步记录 ─────────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4 rounded-2xl border-slate-200">
        <div className="space-y-1">
          <h3 className="text-sm font-black text-slate-900">{t('reviews.logTitle')}</h3>
          <p className="text-xs text-slate-500">{t('reviews.logDesc')}</p>
        </div>

        {runs.length === 0 ? (
          <EmptyState icon={<RefreshCw />} title={t('reviews.logEmpty')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-3">{t('reviews.colTime')}</th>
                  <th className="py-2 pr-3">{t('reviews.colPlatform')}</th>
                  <th className="py-2 pr-3">{t('reviews.colStatus')}</th>
                  <th className="py-2 pr-3 text-right">{t('reviews.colFetched')}</th>
                  <th className="py-2 pr-3 text-right">{t('reviews.colInserted')}</th>
                  <th className="py-2 text-right">{t('reviews.colCost')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-slate-50 align-top">
                    <td className="py-2 pr-3 font-mono text-slate-500 whitespace-nowrap">
                      {run.requestedAt.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="py-2 pr-3 font-bold text-slate-800 uppercase">{run.platform}</td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={run.status} />
                      {/*
                        失败原因原样显示。翻译它没有意义 —— 这串字符是给
                        排障的人看的，翻译过的版本反而搜不到、对不上
                      */}
                      {run.error && (
                        <div className="flex items-start gap-1 pt-1 text-[10px] text-red-700 font-mono max-w-[220px] break-all">
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                          <span>{run.error}</span>
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-slate-700">{run.fetched}</td>
                    <td className="py-2 pr-3 text-right font-mono font-bold text-slate-900">
                      {run.inserted}
                    </td>
                    <td className="py-2 text-right font-mono text-slate-500">
                      {formatCost(run.costMillicents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('reviews.syncConfirmTitle')}
        description={t('reviews.syncConfirmBody')}
        confirmLabel={t('reviews.syncConfirmAction')}
        onConfirm={() => void handleSync()}
      />
    </div>
  );
}

/** 口碑结论的可信度标签（05 §8.3）。低可信度必须显示，不是可选装饰。 */
export function ReviewConfidenceBadge({ confidence }: { confidence: string | null }) {
  const { t } = useLanguage();
  if (confidence !== 'low') return null;
  return (
    <Badge
      variant="warning"
      className="text-[10px] font-bold flex items-center gap-1"
      title={t('reviews.lowConfidenceWhy')}
    >
      <AlertTriangle className="w-3 h-3" />
      <span>{t('reviews.lowConfidence')}</span>
    </Badge>
  );
}
