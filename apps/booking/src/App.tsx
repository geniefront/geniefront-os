/**
 * 门店官网的在线预约页（docs/13）。
 *
 * ## 它是一页，不是一个流程图
 *
 * 客人是躺在沙发上用手机点的，不是坐在电脑前填表。所以整页只有四步，
 * 每一步都在**同一张卡片**里换内容 —— 没有跳页、没有「下一步」的空转，
 * 选完就自动往下走。
 *
 * ## 三条不能省的
 *
 * 1. **时间一律按门店时区**（`lib/format.ts` 有长注释）。
 *    这是这页最容易错、错了最安静的地方
 * 2. **空档会过期**。拉回来的空档不占位，客人填名字的时候可能被人订走 ——
 *    撞上 409 要**重拉空档让他重选**，不是弹一句错误了事（docs/13 §4.3）
 * 3. **店铺电话一直可见**。预约页挂掉的时候，客人手上还有电话就只是不方便；
 *    没有就是一单生意没了（docs/13 §7 那张表最后一行）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError, book, getAvailability, getServices, getShop, hasKey,
  type Availability, type Catalog, type Shop,
} from './lib/api';
import { isEmbedded, localeParam, reportBooked, reportHeight } from './lib/embed';
import { applyLook, readLook, watchSystemMode } from './lib/theme';
import { addDays, todayIn } from './lib/format';
import { ServiceStep } from './screens/ServiceStep';
import { TimeStep } from './screens/TimeStep';
import { DetailsStep } from './screens/DetailsStep';
import { DoneStep } from './screens/DoneStep';
import { Shell, Topbar, Card, Dock, Note, Loading } from './screens/Chrome';

export type Step = 'service' | 'time' | 'details' | 'done';

export interface Draft {
  serviceId: string | null;
  /** ⭐ 加项（docs/13 §4.2）。会加长时长，所以拉空档时必须一起传 */
  addonIds: string[];
  staffId: string | null;
  date: string | null;
  startsAt: string | null;
}

export default function App() {
  const embedded = isEmbedded();
  const locale = localeParam();

  const [shop, setShop] = useState<Shop | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('service');
  const [draft, setDraft] = useState<Draft>(
    { serviceId: null, addonIds: [], staffId: null, date: null, startsAt: null });

  const [avail, setAvail] = useState<Availability | null>(null);
  const [availBusy, setAvailBusy] = useState(false);

  const [done, setDone] = useState<{ code: string | null; id: string; token: string | null } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  /**
   * ⭐ 幂等键：**打开表单时生成一次**，整个提交流程里不变（包括失败重试）。
   *
   * 漏掉它的表现：客人手抖点两下确认，或者网络慢了他自己刷新，
   * 店里那一格被订了两次 —— 前台要打电话去问「您是订了两次还是一次」。
   * 订成之后才换一个新的（他可能接着订第二单）。
   */
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const openedAt = useRef(Date.now());

  // ── 起步：门店信息 + 项目 ────────────────────────────────────────────────
  useEffect(() => {
    if (!hasKey()) { setFatal('NO_PUBLIC_KEY'); return; }
    let alive = true;
    (async () => {
      try {
        const s = await getShop(locale);
        if (!alive) return;
        setShop(s);
        if (!s.onlineBooking.enabled) return;      // 关着就不拉项目了
        const c = await getServices(locale);
        if (alive) setCatalog(c);
      } catch (e) {
        if (alive) setFatal(e instanceof ApiError ? e.code : 'INTERNAL');
      }
    })();
    return () => { alive = false; };
  }, [locale]);

  /**
   * 外观参数（docs/13 §10.4）。
   *
   * ⚠️ 在**第一次绘制之前**就写到 `<html>` 上 —— 用 useEffect 的话，
   * 会先用默认的黑白渲染一帧再跳成老板的品牌色。那一下闪烁在
   * iframe 里格外明显，因为它就嵌在人家配好色的页面中间。
   */
  const look = useOnce(() => {
    const l = readLook();
    applyLook(l);
    return l;
  });

  useEffect(() => watchSystemMode(look, (mode) => {
    document.documentElement.dataset['mode'] = mode;
  }), [look]);

  useEffect(() => {
    if (embedded) document.body.classList.add('embed');
    return reportHeight();
  }, [embedded]);

  useEffect(() => {
    if (shop) document.title = `${shop.name} · 在线预约`;
  }, [shop]);

  // ── 拉空档 ───────────────────────────────────────────────────────────────
  const loadSlots = useCallback(async (
    date: string, serviceId: string, addonIds: string[], staffId: string | null,
  ) => {
    setAvailBusy(true);
    try {
      const a = await getAvailability({ date, serviceId, addonIds, staffId });
      setAvail(a);
      return a;
    } catch {
      setAvail(null);
      return null;
    } finally {
      setAvailBusy(false);
    }
  }, []);

  /**
   * 选完项目自动跳到选时间，并且**自动落在第一个有空档的日子**上。
   *
   * 不这么做的话，一家周一休息的店，客人周日晚上打开看到的是空的 ——
   * 他会以为这家店约满了然后关掉，而其实明天后天都有。
   */
  async function pickService(serviceId: string, addonIds: string[]) {
    setDraft({ serviceId, addonIds, staffId: null, date: null, startsAt: null });
    setStep('time');
    const start = todayIn(shop!.timezone);
    for (let i = 0; i < 14; i++) {
      const date = addDays(start, i);
      const a = await loadSlots(date, serviceId, addonIds, null);
      if (a && a.slots.length > 0) { setDraft((d) => ({ ...d, date })); return; }
    }
    setDraft((d) => ({ ...d, date: start }));
  }

  async function submit(input: Parameters<typeof book>[0]) {
    try {
      const out = await book(input, idem);
      setDone({ code: out.confirmationCode, id: out.bookingId, token: out.manageToken });
      // ⭐ 令牌只给这一次。要做「查看/取消我的预约」就现在存下来
      if (out.manageToken) {
        try { sessionStorage.setItem(`gf:${out.bookingId}`, out.manageToken); } catch { /* 隐私模式 */ }
      }
      reportBooked(out.confirmationCode);
      setIdem(crypto.randomUUID());
      setStep('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;

      // ⭐ 被抢先订走了 —— 重拉空档让他重选，不是报个错了事
      if (e.isTaken) {
        setBanner('这个时段刚被订走了，请另选一个。');
        setStep('time');
        if (draft.date && draft.serviceId) {
          await loadSlots(draft.date, draft.serviceId, draft.addonIds, draft.staffId);
        }
        return;
      }
      if (e.isRateLimited) {
        setBanner(`请求太频繁了，请稍后再试${shop?.phone ? '，或直接致电门店' : ''}。`);
        return;
      }
      throw e;   // 其余交给 DetailsStep 自己翻译成人话
    }
  }

  // ── 进不去的几种情况 ─────────────────────────────────────────────────────
  if (fatal === 'NO_PUBLIC_KEY') {
    return (
      <Shell>
        <Card>
          <h1 className="card-title">链接不完整</h1>
          <p className="card-sub" style={{ marginBottom: 0 }}>
            这个预约链接少了门店标识。请从门店官网上的「立即预约」进来。
          </p>
        </Card>
      </Shell>
    );
  }
  if (fatal) {
    return (
      <Shell>
        <Card>
          <h1 className="card-title">暂时打不开</h1>
          <p className="card-sub">
            {fatal === 'NOT_FOUND'
              ? '找不到这家店 —— 链接可能过期了。'
              : '预约系统暂时无法访问，请稍后再试。'}
          </p>
          <Note>请直接致电门店预约。</Note>
        </Card>
      </Shell>
    );
  }
  if (!shop) return <Shell><Loading /></Shell>;

  // 老板把在线预约关了 —— **只显示电话**，不要显示一个点不动的表单
  if (!shop.onlineBooking.enabled) {
    return (
      <Shell>
        {look.showHeader && <Topbar shop={shop} step={null} />}
        <Card>
          <h1 className="card-title">{shop.name}</h1>
          <p className="card-sub">这家店目前不接受网上预约。</p>
          {shop.phone
            ? <a className="btn btn-primary" style={{ display: 'grid', placeItems: 'center' }}
                 href={`tel:${shop.phone}`}>致电预约 {shop.phone}</a>
            : <Note>请到店或通过官网上的联系方式预约。</Note>}
        </Card>
      </Shell>
    );
  }

  const service = catalog?.services.find((s) => s.id === draft.serviceId) ?? null;
  // 选中的加项。价格和时长都以服务端为准，这里只用来显示给客人看
  const addons = catalog?.addons.filter((a) => draft.addonIds.includes(a.id)) ?? [];

  return (
    <Shell>
      {look.showHeader && <Topbar shop={shop} step={step} />}

      {banner && (
        <div className="card fade glass" style={{ padding: 16 }}>
          <div className="note note-warn">{banner}</div>
        </div>
      )}

      {step === 'service' && (
        catalog
          ? <ServiceStep catalog={catalog} shop={shop}
                         onPick={(id, addonIds) => void pickService(id, addonIds)} />
          : <Card><Loading /></Card>
      )}

      {step === 'time' && service && (
        <TimeStep
          shop={shop} service={service} addons={addons} draft={draft}
          avail={avail} busy={availBusy}
          onDate={(date) => {
            setDraft((d) => ({ ...d, date, startsAt: null }));
            void loadSlots(date, service.id, draft.addonIds, draft.staffId);
          }}
          onStaff={(staffId) => {
            setDraft((d) => ({ ...d, staffId, startsAt: null }));
            if (draft.date) void loadSlots(draft.date, service.id, draft.addonIds, staffId);
          }}
          onSlot={(startsAt) => {
            setBanner(null);
            setDraft((d) => ({ ...d, startsAt }));
            setStep('details');
          }}
          onBack={() => { setBanner(null); setStep('service'); }}
        />
      )}

      {step === 'details' && service && draft.startsAt && (
        <DetailsStep
          shop={shop} service={service} addons={addons}
          startsAt={draft.startsAt} staffId={draft.staffId}
          openedAt={openedAt.current}
          onSubmit={submit}
          onBack={() => setStep('time')}
        />
      )}

      {step === 'done' && done && (
        <DoneStep shop={shop} done={done} onAgain={() => {
          setDraft({ serviceId: null, addonIds: [], staffId: null, date: null, startsAt: null });
          setDone(null); setBanner(null); setStep('service');
          openedAt.current = Date.now();
        }} />
      )}

      {shop.phone && step !== 'done' && (
        <p className="muted center" style={{ marginTop: 18 }}>
          有问题？<a className="tel" href={`tel:${shop.phone}`}>致电 {shop.phone}</a>
        </p>
      )}
    </Shell>
  );
}

/**
 * 只算一次，而且是在 render 阶段。
 *
 * `useMemo` 不保证只算一次（React 可以丢掉缓存重算），而这里的副作用是
 * 「往 <html> 上写属性」—— 重算一次不会出错，但没必要。
 */
function useOnce<T>(fn: () => T): T {
  const ref = useRef<{ v: T } | null>(null);
  ref.current ??= { v: fn() };
  return ref.current.v;
}
