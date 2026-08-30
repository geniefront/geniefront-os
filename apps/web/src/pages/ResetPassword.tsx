import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@heroui/react';
import { Lock, CheckCircle2, ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/LanguageContext';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function ResetPassword() {
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!password) {
      toast.danger(t('credentialsRequired'));
      return;
    }
    if (password.length < 6) {
      toast.danger(t('passwordMinLength'));
      return;
    }
    if (password !== confirmPassword) {
      toast.danger(t('passwordMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        throw error;
      }
      toast.success(t('passwordResetSuccess'));
      navigate('/', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('signInFailed');
      toast.danger(t('saveFailed'), { description: message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md p-8 border-slate-200 shadow-xl shadow-slate-200/50 rounded-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center mx-auto mb-3">
          <Lock className="w-6 h-6" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight mb-2">
          {t('resetPasswordTitle')}
        </h1>
        <p className="text-xs text-slate-500 leading-relaxed">
          {t('resetPasswordSubtitle')}
        </p>
      </div>

      <form className="space-y-4" onSubmit={(e) => void handleResetSubmit(e)}>
        {/* 新密码 */}
        <div>
          <label htmlFor="reset-password" className="block text-xs font-semibold text-slate-700 mb-1">
            {t('password')} <span className="text-slate-400 font-normal">({t('passwordMinLength')})</span>
          </label>
          <div className="relative">
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 bg-slate-50 focus:bg-white text-sm"
            />
            <Lock className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
          </div>
        </div>

        {/* 确认新密码 */}
        <div>
          <label htmlFor="reset-confirm-password" className="block text-xs font-semibold text-slate-700 mb-1">
            {t('confirmPassword')}
          </label>
          <div className="relative">
            <Input
              id="reset-confirm-password"
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

        <Button
          type="submit"
          isPending={submitting}
          className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md h-12 text-sm font-semibold transition-all hover:shadow-lg hover:-translate-y-0.5 mt-4 flex items-center justify-center gap-2"
        >
          <span>{t('setNewPassword')}</span>
          <ArrowRight className="w-4 h-4" />
        </Button>
      </form>
    </Card>
  );
}
