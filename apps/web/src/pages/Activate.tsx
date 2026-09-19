import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast, Spinner } from '@heroui/react';
import { useFieldErrors } from '@/lib/formFeedback';
import { Sparkles, Lock, Store, User, ArrowRight, AlertCircle, CheckCircle2, Mail } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function Activate() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { session, status, claimable, claimStore, reloadLocations, membership } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const initializedFullNameUserId = useRef<string | null>(null);

  // 提取 URL Hash 或 Query 中的错误与状态
  useEffect(() => {
    if (location.hash) {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      const err = params.get('error_description') || params.get('error');
      if (err) {
        setAuthError(decodeURIComponent(err));
      }
    }
  }, [location.hash]);

  // 如果已经具备有效 setup 门店，直接跳转至向导
  useEffect(() => {
    if (membership?.locationStatus === 'setup') {
      navigate('/setup', { replace: true });
    }
  }, [membership, navigate]);

  const userEmail = session?.user?.email ?? email;

  useEffect(() => {
    const user = session?.user;
    if (!user) {
      initializedFullNameUserId.current = null;
      return;
    }
    if (initializedFullNameUserId.current === user.id) return;

    initializedFullNameUserId.current = user.id;
    const metadata = user.user_metadata ?? {};
    if (Object.prototype.hasOwnProperty.call(metadata, 'full_name')) {
      setFullName(typeof metadata.full_name === 'string' ? metadata.full_name : '');
      return;
    }

    // 只在首次加载该用户时提供便利默认值。用户清空后不能再被这个 effect 填回。
    setFullName(user.email?.split('@')[0] ?? '');
  }, [session]);

  /** 激活表单的字段级校验。 */
  const activateForm = useFieldErrors<'password'>();

  async function handleActivateSubmit(e: React.FormEvent) {
    e.preventDefault();

    const targetEmail = (session?.user?.email || email).trim();
    activateForm.clear();
    if (!targetEmail || !password) {
      activateForm.fail('password', t('credentialsRequired'));
      return;
    }
    if (password.length < 6) {
      toast.danger(t('passwordMinLength'));
      return;
    }

    // 如果是已登录通过 Magic Link 建立的会话，需确认两次密码一致
    if (session && password !== confirmPassword) {
      toast.danger(t('passwordMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      if (session) {
        // 1. 已有会话（Magic Link 登录），直接更新密码与个人资料
        const { error: updateError } = await supabase.auth.updateUser({
          password,
          data: {
            // 空字符串是有意清空姓名；undefined 会让 Supabase 忽略这个字段。
            full_name: fullName.trim(),
          },
        });
        if (updateError) throw updateError;
      } else {
        // 2. 未通过 Magic Link 自动登录（如直接输入账号密码），尝试账号密码登录
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: targetEmail,
          password,
        });

        if (signInError) {
          // 如果账号存在但尚未设置密码，支持直接发送 Magic Link
          throw signInError;
        }
      }

      // 认领待开通的门店。失败不能吞掉：密码设置成功但认领失败时，
      // 继续提示“激活成功”并跳向 /setup 会把真正的开户故障伪装成空白页。
      if (claimable) {
        await claimStore();
      } else if (!membership) {
        await reloadLocations();
        throw new Error(t('noMembershipDesc'));
      }

      toast.success(t('activationSuccess'));
      navigate('/setup', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('signInFailed');
      toast.danger(t('signInFailed'), { description: message });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendMagicLink() {
    const targetEmail = email.trim();
    if (!targetEmail) {
      toast.danger(t('credentialsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: targetEmail,
        options: {
          emailRedirectTo: `${window.location.origin}/activate`,
        },
      });
      if (error) throw error;
      toast.success(t('magicLinkSent'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('signInFailed');
      toast.danger(t('signInFailed'), { description: message });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogleLogin() {
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/activate`,
      },
    });
    if (error) {
      setSubmitting(false);
      toast.danger(t('signInFailed'), { description: error.message });
    }
  }

  // 链接失效或报错状态
  if (authError) {
    return (
      <Card className="w-full max-w-md p-8 border-slate-200 shadow-xl shadow-slate-200/50 rounded-2xl animate-in fade-in duration-300">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">{t('magicLinkInvalid')}</h1>
          <p className="text-sm text-slate-500">{authError}</p>
        </div>
        <div className="space-y-3">
          <Button
            type="button"
            className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl h-11 font-semibold"
            onClick={() => navigate('/login', { replace: true })}
          >
            {t('backToLogin')}
          </Button>
        </div>
      </Card>
    );
  }

  // 仅在正在从 URL 解析 Hash Token 且状态为 loading 时短暂展示 spinner
  const hasTokenInHash = Boolean((location.hash || '').includes('access_token=') || (location.search || '').includes('code='));
  if (status === 'loading' && hasTokenInHash) {
    return (
      <Card className="w-full max-w-md p-8 border-slate-200 shadow-xl shadow-slate-200/50 rounded-2xl animate-in fade-in duration-300">
        <div className="text-center py-6 space-y-4">
          <Spinner className="mx-auto" />
          <p className="text-sm font-medium text-slate-600">{t('activating')}</p>
        </div>
      </Card>
    );
  }

  const storeDisplayName = claimable?.shopName || t('setupNewStore');

  return (
    <Card className="w-full max-w-md p-8 border-slate-200 shadow-xl shadow-slate-200/50 rounded-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* 顶部开店欢迎横幅 */}
      <div className="mb-6 rounded-xl bg-teal-50/80 border border-teal-100 p-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0 shadow-sm">
            <Store className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs font-bold text-teal-700 uppercase tracking-wide">
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t('activateWelcome')}</span>
            </div>
            <p className="text-base font-extrabold text-slate-900 truncate">
              {storeDisplayName}
            </p>
          </div>
        </div>
      </div>

      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight mb-2">
          {t('activateTitle')}
        </h1>
        <p className="text-xs text-slate-500 leading-relaxed">
          {session ? t('activateSubtitle') : t('activateDirectSubtitle')}
        </p>
      </div>

      <form className="space-y-4" onSubmit={(e) => void handleActivateSubmit(e)}>
        {/* 账号邮箱 */}
        <div>
          <label htmlFor="activate-email" className="block text-xs font-semibold text-slate-700 mb-1">
            {t('emailAddress')}
          </label>
          <div className="relative">
            <Input
              id="activate-email"
              type="email"
              placeholder="name@example.com"
              value={session?.user?.email ?? email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={Boolean(session?.user?.email)}
              className={`w-full h-10 text-sm ${session?.user?.email ? 'bg-slate-100/80 text-slate-500 font-medium cursor-not-allowed' : 'bg-slate-50 focus:bg-white'}`}
            />
            <Mail className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
          </div>
        </div>

        {/* 店主姓名（已登录模式下提供） */}
        {session && (
          <div>
            <label htmlFor="activate-fullname" className="block text-xs font-semibold text-slate-700 mb-1">
              {t('fullName')}
            </label>
            <div className="relative">
              <Input
                id="activate-fullname"
                type="text"
                placeholder={t('name')}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full h-10 bg-slate-50 focus:bg-white text-sm"
              />
              <User className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
            </div>
          </div>
        )}

        {/* 设置密码 */}
        <div>
          <label htmlFor="activate-password" className="block text-xs font-semibold text-slate-700 mb-1">
            {t('password')} <span className="text-slate-400 font-normal">({t('passwordMinLength')})</span>
          </label>
          <div className="relative">
            <Input
              id="activate-password"
              {...activateForm.bind('password')}
              type="password"
              autoComplete={session ? 'new-password' : 'current-password'}
              placeholder="••••••••"
              value={password}
              onChange={(e) => { setPassword(e.target.value); activateForm.clearField('password'); }}
              className="w-full h-10 bg-slate-50 focus:bg-white text-sm"
            />
            <Lock className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
          </div>
        </div>

        {/* 确认密码（已建立 Magic Link 会话首次设密时必填） */}
        {session && (
          <div>
            <label htmlFor="activate-confirm-password" className="block text-xs font-semibold text-slate-700 mb-1">
              {t('confirmPassword')}
            </label>
            <div className="relative">
              <Input
                id="activate-confirm-password"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full h-10 bg-slate-50 focus:bg-white text-sm"
              />
              <CheckCircle2 className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
            </div>
          </div>
        )}

        <Button
          type="submit"
          isPending={submitting}
          className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md h-12 text-sm font-semibold transition-all hover:shadow-lg hover:-translate-y-0.5 mt-4 flex items-center justify-center gap-2"
        >
          <span>{t('setPasswordAndStart')}</span>
          <ArrowRight className="w-4 h-4" />
        </Button>

        {/* 未登录时的备选快捷操作 */}
        {!session && (
          <>
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200"></div></div>
              <div className="relative flex justify-center text-xs"><span className="px-3 bg-white text-slate-400 font-medium">{t('orContinueWith')}</span></div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                isDisabled={submitting}
                onClick={() => void handleSendMagicLink()}
                className="h-10 text-xs font-semibold border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                <Mail className="w-3.5 h-3.5 mr-1.5 text-teal-600" />
                {t('sendMagicLink')}
              </Button>
              <Button
                type="button"
                variant="outline"
                isDisabled={submitting}
                onClick={() => void handleGoogleLogin()}
                className="h-10 text-xs font-semibold border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                <svg className="w-3.5 h-3.5 mr-1.5" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Google
              </Button>
            </div>
          </>
        )}
      </form>
    </Card>
  );
}
