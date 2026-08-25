/**
 * 客人在**自己手机上**填健康表（`docs/15` §4）。
 *
 * ## 为什么这条路值得单独做一遍
 *
 * 门口那台 iPad 只解决「已经站在店里的人」。而这张表最该在到店之前填完：
 * 客人站在柜台前、后面排着队、用一台公用 iPad 回答「有没有血栓史」——
 * 那种情况下他会一路点「否」，而这张表的全部意义就在他答的是不是真话。
 *
 * ## 它和门口端共用什么、不共用什么
 *
 * **共用那张表本身**（`FormSheet`）：同一份题目、同一块签名板、
 * 同一套六语言。客人看到的东西必须一模一样 —— 两份实现迟早会分叉，
 * 而分叉的那一天，两边签出来的证据就不是同一个东西了。
 *
 * **不共用身份**：门口 iPad 带的是设备令牌（长期、能取号），
 * 这里带的是一条一次性填表令牌（72 小时、只能填表、填完即失效）。
 *
 * ## ⚠️ 这一屏不取号、不签到
 *
 * 客人是在家里的沙发上填的，把他排进队列会让前台看到一个不存在的人。
 * 填完就结束，到店再走正常的签到。
 */

import { useEffect, useState } from 'react';
import {
  formGet, formPost, KioskError, type LinkForms,
} from '../lib/api';
import { makeT, pick, LOCALES, LOCALE_LABEL, type Locale } from '../i18n';
import { FormSheet } from './FormSheet';

const LS_LOCALE = 'gf.kiosk.locale';

type Phase = 'loading' | 'intro' | 'form' | 'done' | 'dead';

export function LinkFlow() {
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'en');
  const t = makeT(locale);

  const [phase, setPhase] = useState<Phase>('loading');
  const [data, setData] = useState<LinkForms | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const r = await formGet<LinkForms>('/public/v1/forms');
        setData(r);
        /**
         * ⚠️ 前台发的时候选了越南语，客人打开却看到英文的话，他多半
         * 直接关掉了。所以链接自带的语言是**默认值**；
         * 他自己手动选过就以他选的为准。
         */
        if (!localStorage.getItem(LS_LOCALE)
            && (LOCALES as readonly string[]).includes(r.locale)) {
          setLocale(r.locale as Locale);
        }
        /**
         * ⭐ 链接自己带着语言（前台发的时候选的），而客人可能又不是那种语言。
         * 所以：**链接的语言只作为默认值**，客人随时能在上面那一排改，
         * 而他最后看的那一种会跟着提交记录存下来。
         */
        const pending = r.forms.filter((f) => !f.done);
        if (pending.length === 0) { setPhase('done'); return; }
        setPhase('intro');
      } catch (e) {
        // ⚠️ 过期、吊销、已填完、不存在 —— 服务端一律回同一句，
        // 这里也只显示同一句。区分开来只对想试探的人有用
        setPhase(e instanceof KioskError ? 'dead' : 'dead');
      }
    })();
  }, []);

  const changeLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem(LS_LOCALE, l);
  };

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

  if (phase === 'loading') {
    return <div className="screen center"><span className="spin" /></div>;
  }

  if (phase === 'dead') {
    return (
      <div className="screen center" style={{ gap: 20 }}>
        {langBar}
        <div className="title">{t('link.dead')}</div>
        <div className="sub" style={{ maxWidth: 520, textAlign: 'center' }}>
          {t('link.deadHint')}
        </div>
        {data?.shopPhone && (
          <a className="btn btn-primary" style={{ minWidth: 260 }} href={`tel:${data.shopPhone}`}>
            {t('link.callShop')}
          </a>
        )}
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="screen center" style={{ gap: 20 }}>
        <div className="title">{t('link.allDone')}</div>
        <div className="sub" style={{ maxWidth: 520, textAlign: 'center' }}>
          {t('link.allDoneHint')}
        </div>
        {data?.shopName && <div className="tiny">{data.shopName}</div>}
      </div>
    );
  }

  const pending = (data?.forms ?? []).filter((f) => !f.done);
  const current = pending[idx];

  if (phase === 'intro' || !current) {
    return (
      <div className="screen" style={{ gap: 24 }}>
        <div className="row" style={{ justifyContent: 'flex-end' }}>{langBar}</div>
        <div className="stack grow center" style={{ gap: 16, textAlign: 'center' }}>
          <div className="tiny">{data?.shopName}</div>
          <div className="title">{t('link.title')}</div>
          <div className="sub" style={{ maxWidth: 520 }}>{t('link.hint')}</div>
          {/*
            ⚠️ 只显示打码的名字。客人要能确认「这是发给我的」，
            而捡到这条链接的人不该因此知道这家店有一位叫什么的客人
          */}
          {data?.maskedName && (
            <div className="sub">{t('link.for')} <strong>{data.maskedName}</strong></div>
          )}
          <div className="tiny">
            {t('link.remaining')} {pending.length} {t('link.forms')}
          </div>
          <button className="btn btn-primary btn-block" style={{ maxWidth: 480, marginTop: 12 }}
                  onClick={() => setPhase('form')}>
            {t('link.start')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
        <span className="tiny">
          {idx + 1} / {pending.length} · {data?.shopName}
        </span>
        {langBar}
      </div>

      <FormSheet
        key={current.templateId}
        form={current}
        locale={locale}
        t={t}
        defaultName=""
        submit={(payload) => formPost('/public/v1/forms/submit', payload)}
        onDone={() => {
          // 服务端在最后一份交完时会把链接封掉，这里只负责往下走
          if (idx + 1 < pending.length) { setIdx(idx + 1); return; }
          setPhase('done');
        }}
        // 这条路上没有「上一步」可回 —— 退出就是关掉页面
        onCancel={() => setPhase('intro')}
      />
    </div>
  );
}
