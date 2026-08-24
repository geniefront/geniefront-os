/**
 * 第四步：订好了。
 *
 * ## ⚠️ 当场把确认码显示出来，不要写「请查收邮件确认」
 *
 * 确认信可能延迟几秒到几分钟（走 outbox，事务提交之后才发）。
 * 写「请查收邮件」的话，客人会盯着收件箱刷新，然后开始怀疑自己没订上 ——
 * 于是打电话来问，前台白接一通（docs/13 §8）。
 *
 * ## 取消按钮为什么在这里、而且只在这里
 *
 * `manageToken` 只在建单响应里给一次，我们把它放进了 sessionStorage。
 * 客人关掉这个标签页就没了 —— 那时候他打电话给店里，
 * **而那正是店家想要的**（有机会挽留）。所以这里不做「输入手机号查预约」，
 * 那等于把客户名单挂在网上（docs/13 §6.7）。
 */

import { useState } from 'react';
import type { Shop } from '../lib/api';
import { ApiError, cancel } from '../lib/api';
import { Card, Dock, Note } from './Chrome';

export function DoneStep({ shop, done, onAgain }: {
  shop: Shop;
  done: { code: string | null; id: string; token: string | null };
  onAgain: () => void;
}) {
  const [state, setState] = useState<'ok' | 'cancelling' | 'cancelled'>('ok');
  const [err, setErr] = useState<string | null>(null);

  async function doCancel() {
    if (!done.token) return;
    setState('cancelling'); setErr(null);
    try {
      await cancel(done.id, done.token);
      setState('cancelled');
      try { sessionStorage.removeItem(`gf:${done.id}`); } catch { /* 隐私模式 */ }
    } catch (e) {
      setState('ok');
      const reason = e instanceof ApiError ? String(e.details['reason'] ?? '') : '';
      setErr(reason === 'cancel_cutoff_passed'
        ? `离开始不到 ${shop.onlineBooking.cancelCutoffHours} 小时了，请直接致电门店${shop.phone ? ` ${shop.phone}` : ''}。`
        : `取消失败，请致电门店${shop.phone ? ` ${shop.phone}` : ''}。`);
    }
  }

  if (state === 'cancelled') {
    return (
      <Card className="done">
        <div className="tick" aria-hidden="true">✓</div>
        <h2 className="card-title">已取消</h2>
        <p className="card-sub">这个预约已经取消了。</p>
        <button className="btn btn-primary" type="button" onClick={onAgain}
                style={{ width: '100%' }}>重新预约</button>
      </Card>
    );
  }

  return (
    <>
      <Card className="done">
        <div className="tick" aria-hidden="true">✓</div>
        <h2 className="card-title">约好了</h2>
        <p className="card-sub" style={{ marginBottom: 0 }}>把这个号码报给前台就行</p>

        <div className="code">{done.code ?? '—'}</div>
        <p className="muted">确认信随后发到你邮箱（如果留了的话）</p>

        {err && <div style={{ marginTop: 16 }}><Note warn>{err}</Note></div>}

        <div className="stack" style={{ marginTop: 22 }}>
          {shop.phone && (
            <a className="btn" style={{ display: 'grid', placeItems: 'center' }}
               href={`tel:${shop.phone}`}>要改时间？致电 {shop.phone}</a>
          )}
          {done.token && (
            <button className="btn" type="button" onClick={() => void doCancel()}
                    disabled={state === 'cancelling'} style={{ width: '100%' }}>
              {state === 'cancelling' ? <span className="spin" /> : '取消这个预约'}
            </button>
          )}
        </div>

        <p className="muted" style={{ marginTop: 18, marginBottom: 0 }}>
          ⚠️ 离开这个页面之后就不能在网上取消了 —— 那时候请打电话给店里。
        </p>
      </Card>

      <Dock>
        <button className="btn btn-primary" type="button" onClick={onAgain}>再订一个</button>
      </Dock>
    </>
  );
}
