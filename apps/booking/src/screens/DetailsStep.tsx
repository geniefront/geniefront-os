/**
 * 第三步：留个联系方式，过一次机器人校验，交单。
 *
 * ## 这一屏上有四样防机器人的东西，其中三样客人看不见
 *
 *   Turnstile   看得见（多数情况下是一个一闪而过的勾）
 *   蜜罐        看不见 —— 真人填不到它，脚本会（docs/13 §6.3）
 *   填表耗时    看不见 —— 三秒内交卷的只有脚本
 *   幂等键      看不见 —— 手抖点两下不会变成两条单
 *
 * ## 🔴 短信勾选框：默认不勾，而且不许预勾
 *
 * 这是**法律要求**（TCPA），不是产品偏好：一条违规 $500–1500。
 * 预约确认短信不需要这个开关（那是交易性短信），它只管**营销**短信。
 */

import { useEffect, useRef, useState } from 'react';
import type { BookInput, Service, Shop } from '../lib/api';
import { ApiError } from '../lib/api';
import { dateOf, duration, money, prettyPhone, timeOf, toE164 } from '../lib/format';
import { loadTurnstile } from '../lib/turnstile';
import { Card, Dock, Note } from './Chrome';

export function DetailsStep({
  shop, service, addons, startsAt, staffId, openedAt, onSubmit, onBack,
}: {
  shop: Shop;
  service: Service;
  /** 选中的加项。⚠️ 最终价格与时长以服务端为准，这里只负责显示 */
  addons: Service[];
  startsAt: string;
  staffId: string | null;
  openedAt: number;
  onSubmit: (input: BookInput) => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);   // ⚠️ 默认 false，不许预勾
  const [website, setWebsite] = useState('');        // 蜜罐

  const [token, setToken] = useState<string | null>(null);
  const [botErr, setBotErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  // ── Turnstile ────────────────────────────────────────────────────────────
  useEffect(() => {
    const key = shop.turnstileSiteKey;
    if (!key || !boxRef.current) return;
    let dead = false;

    void loadTurnstile().then((ts) => {
      if (dead || !boxRef.current || widgetId.current) return;
      widgetId.current = ts.render(boxRef.current, {
        sitekey: key,
        callback: (t: string) => { setToken(t); setBotErr(false); },
        'expired-callback': () => setToken(null),
        'error-callback': () => { setToken(null); setBotErr(true); },
        theme: 'auto',
      });
    }).catch(() => setBotErr(true));

    return () => {
      dead = true;
      if (widgetId.current) { window.turnstile?.remove(widgetId.current); widgetId.current = null; }
    };
  }, [shop.turnstileSiteKey]);

  const e164 = toE164(phone);
  const ready = name.trim().length > 0 && e164 !== null && (token !== null || !shop.turnstileSiteKey);

  async function go() {
    if (!ready || busy) return;
    setBusy(true); setErr(null);
    try {
      await onSubmit({
        turnstileToken: token ?? '',
        ...(shop.locales[0] ? { locale: shop.locales[0] } : {}),
        customer: {
          name: name.trim(),
          phone: e164!,
          ...(email.trim() ? { email: email.trim() } : {}),
          smsOptIn,
        },
        items: [{ serviceId: service.id, addonIds: addons.map((a) => a.id), staffId, startsAt }],
        partySize: 1,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        website,
        formElapsedMs: Date.now() - openedAt,
      });
    } catch (e) {
      setErr(message(e, shop));
      /**
       * ⭐ 重试前必须换一个新的 Turnstile token。
       *
       * 那个 token 用过即废 —— 拿旧的重试会一直 400 `bot_check_failed`，
       * 而真正的原因（比如时段被抢走）已经被这个 400 盖掉了。
       */
      if (widgetId.current) { window.turnstile?.reset(widgetId.current); setToken(null); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <h2 className="card-title">留个联系方式</h2>
        <p className="card-sub">
          {dateOf(startsAt, shop.timezone)} {timeOf(startsAt, shop.timezone)} ·
          {' '}{[service.name, ...addons.map((a) => `＋${a.name}`)].join(' ')} ·
          {' '}{duration(service.durationMin + addons.reduce((n, a) => n + a.durationMin, 0))} ·
          {' '}{money(
            service.priceCents + addons.reduce((n, a) => n + a.priceCents, 0),
            shop.currency)}
        </p>

        <div className="row-fields">
          <div>
            <label className="label" htmlFor="n">称呼</label>
            <input id="n" className="field" value={name} autoComplete="name"
                   maxLength={120} placeholder="怎么称呼您"
                   onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className="label" htmlFor="p">手机号</label>
            <input id="p" className="field" value={phone} inputMode="tel" autoComplete="tel"
                   placeholder="(617) 555-0199"
                   onChange={(e) => setPhone(prettyPhone(e.target.value))} />
            {phone.length > 0 && !e164 && (
              <p className="muted" style={{ marginTop: 6 }}>请填写完整的 10 位手机号</p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="e">邮箱（可不填，填了会收到确认信）</label>
            <input id="e" className="field" value={email} type="email" autoComplete="email"
                   maxLength={200} placeholder="you@example.com"
                   onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div>
            <label className="label" htmlFor="m">备注（可不填）</label>
            <input id="m" className="field" value={notes} maxLength={500}
                   placeholder="第一次来 / 想做浅色 / 带小孩"
                   onChange={(e) => setNotes(e.target.value)} />
          </div>

          {/*
            🔴 TCPA：默认不勾、不许预勾、措辞必须明确。
            预约确认短信**不需要**这个开关（那是交易性短信）——
            它只管促销那一类。一条违规 $500–1500。
          */}
          <label className="check">
            <input type="checkbox" checked={smsOptIn}
                   onChange={(e) => setSmsOptIn(e.target.checked)} />
            <span>
              我同意接收 {shop.name} 的优惠短信。频率不定，回复 STOP 退订，可能产生资费。
              <br />（不勾也不影响预约 —— 预约确认照常发给你）
            </span>
          </label>

          {/* 蜜罐。真人看不见，所以它永远是空的 */}
          <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true"
                 name="website" value={website}
                 onChange={(e) => setWebsite(e.target.value)} />

          {shop.turnstileSiteKey && <div ref={boxRef} style={{ minHeight: 66 }} />}
          {botErr && <Note warn>安全校验没通过，请刷新页面重试。</Note>}
          {err && <Note warn>{err}</Note>}
        </div>
      </Card>

      <Dock>
        <button className="btn btn-ghost" type="button" onClick={onBack} disabled={busy}>
          上一步
        </button>
        <button className="btn btn-primary" type="button" onClick={() => void go()}
                disabled={!ready || busy}>
          {busy ? <span className="spin" /> : '确认预约'}
        </button>
      </Dock>
    </>
  );
}

/**
 * 把错误码翻成客人看得懂的话。
 *
 * ⚠️ **一定要给电话**。预约页出问题的时候，客人手上还有店铺电话
 * 就只是不方便；没有就是一单生意没了（docs/13 §7）。
 */
function message(e: unknown, shop: Shop): string {
  const tail = shop.phone ? `，或致电 ${shop.phone}` : '';
  if (!(e instanceof ApiError)) return `出了点问题，请重试${tail}。`;

  const reason = String(e.details['reason'] ?? '');
  if (reason === 'bot_check_failed') return '安全校验没通过，请再试一次。';
  if (reason === 'too_soon') return `这个时间太近了，请直接致电门店${shop.phone ? ` ${shop.phone}` : ''}。`;
  if (reason === 'too_many_upcoming') return `你已经有几个还没到的预约了。要再约请致电门店${shop.phone ? ` ${shop.phone}` : ''}。`;
  if (reason === 'date_out_of_window') return '这个日期太远了，请另选一天。';
  if (reason === 'origin_not_allowed') return '这个页面还没被门店授权，请联系门店。';
  if (e.code === 'NOT_FOUND') return '这个项目刚下架了，请回上一步重新选。';
  if (e.status === 0) return `网络不太好，请检查后重试${tail}。`;
  return `暂时订不了，请稍后再试${tail}。`;
}
