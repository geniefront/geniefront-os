/**
 * 营销邮件退订页。无需登录。
 *
 * 邮件正文链到 `${BOOKING_PAGE_ORIGIN}/unsubscribe?t=`。
 * 打开本页不得改订阅状态（API GET 是只读的）；客人点确认后才 POST。
 *
 * 令牌无效、已退订、缺 token：界面与成功态相同，避免把这条页变成
 * 「拿令牌探测顾客是否存在」的入口。
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { AuthLayout } from '@/components/AuthLayout';
import { API_BASE } from '@/lib/api';

type Phase = 'confirm' | 'working' | 'done';

export function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('t')?.trim() ?? '';
  const [phase, setPhase] = useState<Phase>('confirm');

  async function confirm() {
    setPhase('working');
    try {
      await fetch(
        `${API_BASE}/public/v1/email/unsubscribe?t=${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
    } catch {
      /* 网络失败也落到同一句：客人以为没退掉会再点一次，重复 POST 是幂等的 */
    }
    setPhase('done');
  }

  return (
    <AuthLayout>
      <Card className="w-full max-w-md">
        <CardContent className="p-8">
          {phase === 'done' ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" aria-hidden />
              <h1 className="text-xl font-semibold text-slate-900">You are unsubscribed</h1>
              <p className="text-sm leading-6 text-slate-600">
                You will no longer receive marketing emails from this business.
                Appointment confirmations and reminders are not affected.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <h1 className="text-xl font-semibold text-slate-900">Unsubscribe from marketing emails</h1>
              <p className="text-sm leading-6 text-slate-600">
                You will stop receiving birthday, holiday, win-back, and review emails.
                You will still get appointment confirmations and reminders.
              </p>
              <Button
                className="w-full"
                onPress={() => { void confirm(); }}
                isDisabled={phase === 'working'}
              >
                {phase === 'working' ? 'Please wait…' : 'Unsubscribe'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
