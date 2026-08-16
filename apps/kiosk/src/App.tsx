/**
 * 门口 iPad —— 自助签到 / 取号 / 签免责书。
 *
 * ⚠️ **宪法第 14 条**：这一端是可选增强。它挂了、没配、被拔了网线，
 * 前台照样能在自己那台电脑上代客人取号、代签免责书。所以这里
 * 没有任何一步是「只能在这里做」的。
 *
 * ⚠️ **宪法第 12 条**：Kiosk 不设任何快捷键。前面站的是客人，
 * 不是每天点几百次的前台。
 *
 * 五步，一屏一步：
 *   ① 选语言 → ② 有没有预约 → ③ 手机号 / 留个称呼
 *   → ④ 该签的表（多语言 + 手写签名）→ ⑤ 大号码
 */

import { useEffect, useState } from 'react';
import {
  apiGet, apiPost, getToken, setToken, KioskError,
  type Hello, type LookupResult, type QueueTicket, type RequiredForm,
} from './lib/api';
import { makeT, pick, LOCALES, LOCALE_LABEL, type Locale } from './i18n';
import { FormSheet } from './screens/FormSheet';

type Step = 'setup' | 'welcome' | 'home' | 'phone' | 'pick' | 'walkin' | 'form' | 'done';

const LS_LOCALE = 'gf.kiosk.locale';

export default function App() {
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');
  const t = makeT(locale);

  const [step, setStep] = useState<Step>(getToken() ? 'welcome' : 'setup');
  const [hello, setHello] = useState<Hello | null>(null);
  /**
   * ⚠️ 存的是 **i18n key** 不是译好的句子。
   *
   * 存译文的话，客人一进来是中文界面、报了个中文错，然后他切成越南语 ——
   * 整屏都变了，只有那句最需要他看懂的报错还是中文。
   */
  const [errKey, setErrKey] = useState('');
  const err = errKey ? t(errKey) : '';
  const [busy, setBusy] = useState(false);

  // 流程中的状态
  const [phone, setPhone] = useState('');
  const [matches, setMatches] = useState<LookupResult['matches']>([]);
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [walkInName, setWalkInName] = useState('');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [partySize, setPartySize] = useState(1);
  const [forms, setForms] = useState<RequiredForm[]>([]);
  const [ticket, setTicket] = useState<QueueTicket | null>(null);

  /** 开机自检。令牌被吊销时立刻显示「找前台」，而不是等客人输完号码才报错 */
  useEffect(() => {
    if (!getToken()) return;
    void (async () => {
      try {
        setHello(await apiGet<Hello>('/v1/kiosk/hello'));
      } catch (e) {
        if (e instanceof KioskError && e.status === 401) setStep('setup');
        else setErrKey('err.generic');
      }
    })();
  }, []);

  /** 回到起点。客人走了之后必须把上一个人的信息清干净 —— 门口那台机器是公用的 */
  function reset() {
    setPhone(''); setMatches([]); setAppointmentId(null);
    setWalkInName(''); setServiceId(null); setPartySize(1);
    setForms([]); setTicket(null); setErrKey('');
    setStep('welcome');
  }

  /** 取完号之后自动回首屏 —— 客人不会自己点「完成」，他拿了号就走了 */
  useEffect(() => {
    if (step !== 'done') return;
    const timer = setTimeout(reset, 45_000);
    return () => clearTimeout(timer);
  }, [step]);

  const changeLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem(LS_LOCALE, l);
  };

  // ── 各步的动作 ──────────────────────────────────────────────────────────

  async function lookup() {
    setBusy(true); setErrKey('');
    try {
      const r = await apiPost<LookupResult>('/v1/kiosk/check-in/lookup', { phone });
      if (r.matches.length === 0) { setErrKey('phone.notFound'); return; }
      setMatches(r.matches);
      setStep('pick');
    } catch (e) {
      setErrKey(e instanceof KioskError && e.details['reason'] === 'too_many_attempts'
        ? 'err.tooMany' : 'err.generic');
    } finally { setBusy(false); }
  }

  /** 确认是本人 → 看看要不要签表 → 取号 */
  async function confirmMe(apptId: string) {
    setBusy(true); setErrKey('');
    setAppointmentId(apptId);
    try {
      const need = await apiGet<{ forms: RequiredForm[] }>('/v1/kiosk/forms/required');
      if (need.forms.length > 0) { setForms(need.forms); setStep('form'); return; }
      await doCheckIn(apptId);
    } catch {
      setErrKey('err.generic');
    } finally { setBusy(false); }
  }

  async function doCheckIn(apptId: string) {
    const r = await apiPost<QueueTicket>('/v1/kiosk/check-in', { appointmentId: apptId });
    setTicket(r); setStep('done');
  }

  /**
   * walk-in 也要先问该签的表。
   *
   * ⚠️ 一开始只在「有预约」那条路上查了表，walk-in 直接取号 ——
   * 而按摩 / 足疗店里**最需要签免责书的恰恰是 walk-in**：
   * 有预约的老客多半早就签过，走进来的生客一份都没有。
   */
  async function startWalkIn() {
    setBusy(true); setErrKey('');
    try {
      const need = await apiGet<{ forms: RequiredForm[] }>(
        `/v1/kiosk/forms/required${serviceId ? `?serviceId=${serviceId}` : ''}`);
      if (need.forms.length > 0) { setForms(need.forms); setStep('form'); return; }
      await doWalkIn();
    } catch (e) {
      setErrKey(e instanceof KioskError && e.details['reason'] === 'too_many_attempts'
        ? 'err.tooMany' : 'err.generic');
    } finally { setBusy(false); }
  }

  async function doWalkIn() {
    setBusy(true); setErrKey('');
    try {
      const r = await apiPost<QueueTicket>('/v1/kiosk/walk-in', {
        name: walkInName.trim(),
        serviceId,
        partySize,
        // 幂等键在客户端生成：门口这台机器的网常常是店里最差的一条，
        // 重试不能变成两个号（客人手上会拿到两张纸，前台会喊两次）
        idempotencyKey: crypto.randomUUID(),
      });
      setTicket(r); setStep('done');
    } catch (e) {
      setErrKey(e instanceof KioskError && e.details['reason'] === 'too_many_attempts'
        ? 'err.tooMany' : 'err.generic');
    } finally { setBusy(false); }
  }

  // ── 各屏 ────────────────────────────────────────────────────────────────

  if (step === 'setup') {
    return <SetupScreen t={t} onSaved={() => { setStep('welcome'); location.reload(); }} />;
  }

  const langBar = (
    <div className="lang-bar">
      {LOCALES.map((l) => (
        <button key={l} className="btn lang-btn" aria-pressed={l === locale}
                onClick={() => changeLocale(l)}>
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );

  if (step === 'welcome') {
    return (
      <div className="screen center" style={{ gap: 40 }}>
        <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
          <div className="title" style={{ fontSize: 'var(--text-2xl)' }}>
            {hello ? pick(hello.locationName, locale) : ''}
          </div>
          <div className="title">{t('welcome.title')}</div>
          <div className="sub">{t('welcome.pick')}</div>
        </div>
        <div className="lang-bar" style={{ justifyContent: 'center', maxWidth: 620 }}>
          {LOCALES.map((l) => (
            <button key={l} className="btn"
                    style={{ minHeight: 80, minWidth: 190, fontSize: 'var(--text-lg)' }}
                    onClick={() => { changeLocale(l); setStep('home'); }}>
              {LOCALE_LABEL[l]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
        <button className="btn" style={{ minHeight: 56 }} onClick={reset}>
          ← {t('phone.back')}
        </button>
        {langBar}
      </div>

      {err && (
        <div className="card" style={{
          padding: 20, borderColor: 'var(--warn)', background: 'var(--warn-soft)',
          fontSize: 'var(--text)',
        }}>
          ⚠ {err}
          {errKey === 'phone.notFound' && (
            <div className="tiny" style={{ marginTop: 8 }}>{t('phone.notFoundHint')}</div>
          )}
        </div>
      )}

      {step === 'home' && (
        <div className="stack grow" style={{ gap: 20, justifyContent: 'center' }}>
          <div className="title">{t('welcome.title')}</div>
          <div className="sub">{t('home.hint')}</div>
          <button className="btn btn-primary btn-block btn-huge"
                  onClick={() => setStep('phone')}>
            <span style={{ fontSize: 44 }}>📅</span>
            {t('home.checkIn')}
          </button>
          <button className="btn btn-block btn-huge" onClick={() => setStep('walkin')}>
            <span style={{ fontSize: 44 }}>🙋</span>
            {t('home.walkIn')}
          </button>
        </div>
      )}

      {step === 'phone' && (
        <PhoneScreen t={t} phone={phone} busy={busy}
                     onChange={setPhone} onNext={() => void lookup()} />
      )}

      {step === 'pick' && (
        <div className="stack grow" style={{ gap: 16, justifyContent: 'center' }}>
          <div className="title">{t('pick.title')}</div>
          <div className="sub">{t('pick.hint')}</div>
          {/* 同号多客户（夫妻/母女共号）时让客人自己点 —— 决策 21 的客人侧体现 */}
          {matches.map((m) => (
            <button key={m.appointmentId} className="btn btn-block"
                    disabled={busy}
                    style={{ minHeight: 96, fontSize: 'var(--text-lg)',
                             justifyContent: 'space-between' }}
                    onClick={() => void confirmMe(m.appointmentId)}>
              <span>{m.maskedName}</span>
              <span className="tiny">
                {new Date(m.startsAt).toLocaleTimeString(locale, {
                  hour: '2-digit', minute: '2-digit', hour12: false })}
                {m.alreadyQueued ? ' ✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {step === 'walkin' && (
        <WalkInScreen t={t} locale={locale} hello={hello} busy={busy}
                      name={walkInName} onName={setWalkInName}
                      serviceId={serviceId} onService={setServiceId}
                      partySize={partySize} onParty={setPartySize}
                      onSubmit={() => void startWalkIn()} />
      )}

      {step === 'form' && forms.length > 0 && (
        <FormSheet
          form={forms[0]!} locale={locale} t={t}
          defaultName={walkInName}
          onDone={async () => {
            const rest = forms.slice(1);
            setForms(rest);
            if (rest.length > 0) return;
            // 表签完了才真正取号 —— 反过来的话，客人拿了号却没签，
            // 前台叫到他时才发现，那时候他已经坐下了
            setBusy(true);
            try {
              if (appointmentId) await doCheckIn(appointmentId);
              else await doWalkIn();
            } catch { setErrKey('err.generic'); }
            finally { setBusy(false); }
          }}
          onCancel={reset}
        />
      )}

      {step === 'done' && ticket && (
        <div className="stack grow center" style={{ gap: 20 }}>
          <div className="title">{t('done.title')}</div>
          <div className="sub">{t('done.yourNumber')}</div>
          <div className="ticket-number">{ticket.ticketNumber}</div>

          {ticket.aheadCount === 0 ? (
            <div className="badge badge-ok" style={{ fontSize: 'var(--text)' }}>
              {t('done.noWait')}
            </div>
          ) : (
            <div className="stack" style={{ gap: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 'var(--text-lg)' }}>
                {t('done.ahead')} <strong>{ticket.aheadCount}</strong> {t('done.people')}
              </div>
              {ticket.quotedWaitMin !== null && ticket.quotedWaitMin > 0 && (
                <div className="sub">
                  {t('done.about')} {ticket.quotedWaitMin} {t('done.minutes')}
                </div>
              )}
            </div>
          )}

          <div className="tiny" style={{ maxWidth: 420 }}>{t('done.keepScreen')}</div>
          <button className="btn btn-primary" style={{ minWidth: 260 }} onClick={reset}>
            {t('done.finish')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── 手机号

function PhoneScreen({ t, phone, busy, onChange, onNext }: {
  t: (k: string) => string; phone: string; busy: boolean;
  onChange: (v: string) => void; onNext: () => void;
}) {
  /** `(512) 555-1234` —— 客人核对自己号码时按这个分组看最快 */
  const pretty = (v: string) => {
    if (v.length <= 3) return v;
    if (v.length <= 6) return `(${v.slice(0, 3)}) ${v.slice(3)}`;
    return `(${v.slice(0, 3)}) ${v.slice(3, 6)}-${v.slice(6, 10)}`;
  };

  return (
    <div className="stack grow" style={{ gap: 16, justifyContent: 'center' }}>
      <div className="title">{t('phone.title')}</div>
      <div className="sub">{t('phone.hint')}</div>

      <div className="card phone-display">{pretty(phone) || ' '}</div>

      {/* 数字键盘而不是系统输入法：门口那台 iPad 开着引导式访问，
          系统键盘会挡掉半屏，而且老人家找不到数字那一栏 */}
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} className="btn" disabled={busy}
                  onClick={() => onChange((phone + d).slice(0, 10))}>{d}</button>
        ))}
        <button className="btn" disabled={busy} onClick={() => onChange('')}>
          {t('phone.clear')}
        </button>
        <button className="btn" disabled={busy}
                onClick={() => onChange((phone + '0').slice(0, 10))}>0</button>
        <button className="btn" disabled={busy}
                onClick={() => onChange(phone.slice(0, -1))}>⌫</button>
      </div>

      <button className="btn btn-primary btn-block"
              disabled={busy || phone.length < 7}
              onClick={onNext}>
        {busy ? <span className="spin" /> : t('phone.next')}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── walk-in

function WalkInScreen({
  t, locale, hello, busy, name, onName, serviceId, onService,
  partySize, onParty, onSubmit,
}: {
  t: (k: string) => string; locale: Locale; hello: Hello | null; busy: boolean;
  name: string; onName: (v: string) => void;
  serviceId: string | null; onService: (v: string | null) => void;
  partySize: number; onParty: (v: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="stack grow" style={{ gap: 16 }}>
      <div className="title">{t('walkin.title')}</div>
      <div className="sub">{t('walkin.hint')}</div>

      <input className="field" value={name} autoFocus
             placeholder={t('walkin.namePlaceholder')}
             onChange={(e) => onName(e.target.value)} />

      <div className="sub" style={{ marginTop: 8 }}>{t('walkin.party')}</div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className="btn"
                  style={{
                    minWidth: 88,
                    borderColor: partySize === n ? 'var(--brand)' : 'var(--line)',
                    background: partySize === n ? 'var(--brand-soft)' : 'var(--surface)',
                  }}
                  onClick={() => onParty(n)}>{n}</button>
        ))}
      </div>

      <div className="sub" style={{ marginTop: 8 }}>{t('walkin.service')}</div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {/* 「还没想好」放在最前面 —— 真店里这是最常见的答案 */}
        <button className="btn"
                style={{
                  borderColor: serviceId === null ? 'var(--brand)' : 'var(--line)',
                  background: serviceId === null ? 'var(--brand-soft)' : 'var(--surface)',
                }}
                onClick={() => onService(null)}>{t('walkin.skipService')}</button>
        {(hello?.services ?? []).slice(0, 12).map((s) => (
          <button key={s.id} className="btn"
                  style={{
                    borderColor: serviceId === s.id ? 'var(--brand)' : 'var(--line)',
                    background: serviceId === s.id ? 'var(--brand-soft)' : 'var(--surface)',
                  }}
                  onClick={() => onService(s.id)}>
            {pick(s.name, locale)}
          </button>
        ))}
      </div>

      <div className="grow" />
      <button className="btn btn-primary btn-block"
              disabled={busy || name.trim().length === 0}
              onClick={onSubmit}>
        {busy ? <span className="spin" /> : t('phone.next')}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── 配对

function SetupScreen({ t, onSaved }: { t: (k: string) => string; onSaved: () => void }) {
  const [v, setV] = useState('');
  return (
    <div className="screen center" style={{ gap: 20 }}>
      <div className="title">{t('setup.title')}</div>
      <div className="sub" style={{ maxWidth: 520 }}>{t('setup.hint')}</div>
      <input className="field" value={v} autoFocus
             style={{ maxWidth: 620, fontFamily: 'ui-monospace, monospace',
                      fontSize: 'var(--text)' }}
             placeholder={t('setup.paste')}
             onChange={(e) => setV(e.target.value)} />
      <button className="btn btn-primary" style={{ minWidth: 260 }}
              disabled={!v.trim().startsWith('gfk_')}
              onClick={() => { setToken(v); onSaved(); }}>
        {t('setup.save')}
      </button>
    </div>
  );
}
