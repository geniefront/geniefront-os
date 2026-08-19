/**
 * 开通门店 —— 老板点开激活邮件里的链接之后落在这一屏（docs/12 §3 B）。
 *
 * ## 这一屏存在的全部理由
 *
 * 他刚在官网付完钱，收到一封信，点进来。这一刻他在系统里只有一个
 * Supabase 账号 —— **没有门店、没有身份、没有任何权限**。
 * 这一屏做的就一件事：把那家已经付了钱的店和这个账号绑在一起。
 *
 * ## 三个刻意的决定
 *
 * 1. **自动开始，不要一个「开始」按钮。** 他点邮件里的链接就是同意了，
 *    再让他点一次只是多一次可以失败的机会。
 * 2. **失败的话给的是能打的电话，不是错误码。** 走到这一步的人
 *    已经付过钱了 —— 让他看到 `NOT_FOUND` 是最糟的一种收场。
 * 3. **成功之后直接进店**，不回选店器。他现在只有一家店。
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, claimLocation } from '../lib/api';
import { supabase } from '../lib/supabase';

type State =
  | { k: 'working' }
  | { k: 'done' }
  | { k: 'nothing' }        // 这个邮箱名下没有待开通的店
  | { k: 'failed'; code: string };

export function Activate({ onClaimed }: {
  /** 认领成功之后由外面决定去哪 —— 认领的是哪一家，就直接进哪一家 */
  onClaimed: (membershipId: string) => Promise<unknown>;
}) {
  const [st, setSt] = useState<State>({ k: 'working' });
  // StrictMode 下 effect 会跑两次 —— 认领是一次性的，跑两次的话
  // 第二次必然撞上「已经认领过」，然后给一个刚开通成功的人看一个错误
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const claimedShop = await claimLocation();
        setSt({ k: 'done' });
        // ⚠️ 先切状态再交棒：onClaimed 会把人送进新店，
        // 而在那之前这一屏至少闪过一次「开通完成」，他知道刚才那一下成了
        await onClaimed(claimedShop.membershipId);
      } catch (e) {
        if (e instanceof ApiError && e.details['reason'] === 'no_claimable_signup') {
          setSt({ k: 'nothing' });
        } else {
          setSt({ k: 'failed', code: e instanceof ApiError ? e.code : 'UNKNOWN' });
        }
      }
    })();
  }, [onClaimed]);

  return (
    <div className="center-page">
      <div className="card stack" style={{ width: 'min(520px, 100%)', padding: 32, gap: 18 }}>
        <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800 }}>
          {st.k === 'working' ? '正在开通你的店铺…' : st.k === 'done' ? '开通完成 🎉' : '开通没能完成'}
        </div>

        {st.k === 'working' && (
          <div className="row" style={{ gap: 12 }}>
            <span className="spin" />
            <span className="muted">正在把你的账号和付款的那家店绑定，几秒钟就好。</span>
          </div>
        )}

        {st.k === 'done' && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="badge badge-ok" style={{ padding: '10px 14px', fontSize: 'var(--text)' }}>
              ✓ 你已经是这家店的老板了
            </div>
            <div className="muted">接下来我们用几分钟把店配起来。</div>
          </div>
        )}

        {/*
          走到这两个分支的人**已经付过钱了**。所以这里给的是
          「下一步该干什么」和一个能联系上人的地址，不是一个错误码。
        */}
        {st.k === 'nothing' && (
          <div className="stack" style={{ gap: 12 }}>
            <div>这个邮箱名下没有等待开通的店铺。</div>
            <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
              <li>如果你刚付完款，等一两分钟再点一次邮件里的链接</li>
              <li>如果店已经开通过了，直接<b>登录</b>就行</li>
              <li>如果你用了另一个邮箱付款，请用<b>付款那个邮箱</b>打开链接</li>
            </ul>
            <div className="muted">还是不行：support@geniefront.com</div>
          </div>
        )}

        {st.k === 'failed' && (
          <div className="stack" style={{ gap: 12 }}>
            <div>我们这边出了点问题，你的付款没有丢。</div>
            <div className="muted">
              把这一行发给我们就能查到：<code>{st.code}</code><br />
              support@geniefront.com
            </div>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              再试一次
            </button>
          </div>
        )}

        {(st.k === 'nothing' || st.k === 'failed') && (
          <button className="btn" onClick={() => void supabase.auth.signOut()}>
            换一个账号登录
          </button>
        )}
      </div>
    </div>
  );
}
