import { useState } from 'react';
import { toast } from '@heroui/react';
import { supabase } from '@/lib/supabase';
import { requestPasswordReset, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLanguage } from '@/LanguageContext';

export function Login() {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /**
   * 邮箱密码登录。
   *
   * 成功后不做显式跳转：`SessionProvider` 订阅了 Supabase 的认证状态变更，
   * 会话建立后应用外壳自行切换到选店流程或主界面。在此处再跳转一次会与该流程
   * 产生竞争，导致中间态闪烁。
   */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast.danger(t('credentialsRequired'));
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (error) {
      toast.danger(t('signInFailed'), { description: error.message });
    }
  }

  async function handleGoogleLogin() {
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (error) {
      setSubmitting(false);
      toast.danger(t('signInFailed'), { description: error.message });
    }
  }

  /**
   * 请求发送重置密码邮件。
   *
   * ⚠️ 成功提示必须写成条件句（「如果该邮箱已注册…」）。服务端对已注册与未注册
   * 的邮箱一律返回 200，正是为了不让该接口成为探测客户名单的入口；
   * 若界面在此处断言「邮件已发送给你」，等于把服务端刻意隐藏的信息重新泄露出去。
   */
  async function handleResetPassword(e: React.MouseEvent) {
    e.preventDefault();
    if (!email.trim()) {
      toast.danger(t('credentialsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      toast.success(t('resetPasswordSent'), { description: t('resetPasswordGoogleHint') });
    } catch (err) {
      // 限频是唯一需要单独呈现的失败：它与账号是否存在无关，且用户可以通过等待恢复。
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        const retryAfter = Number(err.details['retryAfterSec'] ?? 60);
        toast.danger(t('rateLimited'), { description: `${retryAfter}s` });
      } else {
        toast.danger(t('signInFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md p-6 sm:p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-2 tracking-tight">{t('welcomeBack')}</h1>
        <p className="text-slate-500">{t('loginSubtitle')}</p>
      </div>
      <form className="space-y-5" onSubmit={(e) => void submit(e)}>
        <div>
          <label htmlFor="login-email" className="block text-sm font-semibold text-slate-700 mb-1.5">
            {t('emailAddress')}
          </label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-11 bg-slate-50 focus:bg-white transition-colors"
          />
        </div>
        <div>
          <label htmlFor="login-password" className="flex justify-between text-sm font-semibold text-slate-700 mb-1.5">
            {t('password')}
            <button
              type="button"
              onClick={(e) => void handleResetPassword(e)}
              className="text-teal-600 hover:text-teal-700 font-medium text-xs transition-colors"
            >
              {t('forgotPassword')}
            </button>
          </label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-11 bg-slate-50 focus:bg-white transition-colors"
          />
        </div>

        <Button
          type="submit"
          isPending={submitting}
          className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md h-12 text-base font-semibold transition-all hover:shadow-lg hover:-translate-y-0.5 mt-2"
        >
          {t('signIn')}
        </Button>
        
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200"></div></div>
          <div className="relative flex justify-center text-sm"><span className="px-3 bg-white text-slate-500 font-medium">{t('orContinueWith')}</span></div>
        </div>
        
        <div className="block">
          <Button
            type="button"
            variant="outline"
            onPress={() => void handleGoogleLogin()}
            isDisabled={submitting}
            className="w-full h-12 rounded-xl text-slate-700 font-semibold border-slate-200 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center justify-center gap-2">
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {t('signInWithGoogle')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
