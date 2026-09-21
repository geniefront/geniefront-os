import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/LanguageContext';
import { BillingPanel } from './BillingPanel';
import type { BillingView, BillingInvoiceItem, QuotaView } from './types';

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  danger: vi.fn(),
}));

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast };
});

const billingState = {
  data: { billing: null as BillingView | null, autoTopup: null },
  isLoading: false,
  refetch: vi.fn(),
};
const invoicesState = {
  data: { invoices: [] as BillingInvoiceItem[] },
  isLoading: false,
};
const portalMutate = vi.fn();
const paymentMethodMutate = vi.fn();
const topupMutate = vi.fn();
const autoTopupMutate = vi.fn();
const portalState = {
  isPending: false,
  mutateAsync: (...args: unknown[]) => portalMutate(...args),
};
const paymentMethodState = {
  isPending: false,
  mutateAsync: (...args: unknown[]) => paymentMethodMutate(...args),
};
const topupState = {
  isPending: false,
  mutateAsync: (...args: unknown[]) => topupMutate(...args),
};
const redeemMutate = vi.fn();
const redeemState = {
  isPending: false,
  mutateAsync: (code: string) => redeemMutate(code) as Promise<unknown>,
};
const autoTopupState = {
  isPending: false,
  mutateAsync: async (input: { unit: QuotaView['unit']; enabled: boolean; thresholdUnits: number }) => {
    const res = await autoTopupMutate(input);
    const billing = billingState.data.billing;
    if (billing) {
      billingState.data = {
        ...billingState.data,
        billing: {
          ...billing,
          quotas: billing.quotas.map((quota) => (
            quota.unit === input.unit
              ? {
                  ...quota,
                  autoTopup: {
                    ...quota.autoTopup,
                    enabled: input.enabled,
                    thresholdUnits: input.thresholdUnits,
                  },
                }
              : quota
          )),
        },
      };
    }
    return res;
  },
};

vi.mock('./api', () => ({
  useConfirmOwnershipPayment: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useBillingQuery: () => billingState,
  useInvoicesQuery: () => invoicesState,
  useCreateBillingPortalSession: () => portalState,
  useCreatePaymentMethodSession: () => paymentMethodState,
  useCreateTopup: () => topupState,
  useSetAutoTopup: () => autoTopupState,
  useRedeemLicenseCode: () => redeemState,
}));

/**
 * 账单邮件语言那一项走的是 settings 的查询与命令，此处一并替身 ——
 * 它们内部要 `useSession()`，而本测试不套 SessionProvider。
 */
const emailLocaleMutate = vi.fn();
const deskSettingsState = { data: { emailLocale: 'en' as const } };
vi.mock('@/features/settings/api', () => ({
  useDeskSettingsQuery: () => deskSettingsState,
  useSetEmailLocale: () => ({
    isPending: false,
    mutate: (...args: unknown[]) => emailLocaleMutate(...args),
  }),
}));

function quota(
  unit: 'credit' | 'voice_minute',
  used: number,
  total: number,
  over: Partial<QuotaView> = {},
): QuotaView {
  return {
    unit,
    included: { used, total, remaining: Math.max(0, total - used) },
    balance: 0,
    unitsPerTopup: unit === 'credit' ? 1000 : 200,
    autoTopup: { enabled: false, thresholdUnits: unit === 'credit' ? 50 : 20, failures: 0, lastAt: null },
    usedThisMonth: used,
    ...over,
  };
}

function essentialTrial(over: Partial<BillingView> = {}): BillingView {
  return {
    plan: 'essential',
    subscriptionStatus: 'trialing',
    currentPeriodEnd: '2026-09-07T00:00:00.000Z',
    hasSubscription: true,
    billingSource: 'stripe',
    licensePeriodEnd: null,
    trialEndsAt: '2026-09-07T00:00:00.000Z',
    trialing: true,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    hasPaymentMethod: false,
    paymentMethodLabel: null,
    topupPriceCents: 5000,
    quotas: [quota('credit', 12, 150), quota('voice_minute', 3, 20)],
    recent: [],
    ...over,
  };
}

function renderPanel() {
  return render(
    <LanguageProvider>
      <BillingPanel />
    </LanguageProvider>,
  );
}

describe('BillingPanel 真实计费状态', () => {
  beforeEach(() => {
    toast.success.mockReset();
    toast.danger.mockReset();
    portalMutate.mockReset();
    paymentMethodMutate.mockReset();
    topupMutate.mockReset();
    autoTopupMutate.mockReset();
    redeemMutate.mockReset();
    billingState.refetch.mockReset();
    billingState.isLoading = false;
    invoicesState.isLoading = false;
    billingState.data = { billing: essentialTrial(), autoTopup: null };
    invoicesState.data = { invoices: [] };
  });

  it('Essential 试用显示 Essential 与试用，而不是 Growth active', () => {
    renderPanel();
    expect(screen.getAllByText(/基础版 \(Essential\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/试用中/).length).toBeGreaterThan(0);
    expect(screen.getByText(/试用结束日: 2026-09-07/)).toBeInTheDocument();
    expect(screen.queryByText(/增长旗舰版 \(Growth\) · 订阅生效中/)).not.toBeInTheDocument();
    expect(screen.queryByText('$169')).not.toBeInTheDocument();
    expect(screen.queryByText('$89')).not.toBeInTheDocument();
    expect(screen.queryByText('$299')).not.toBeInTheDocument();
  });

  it('没有 Starter / Enterprise 切换写入口', () => {
    renderPanel();
    expect(screen.queryByText(/Starter/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enterprise/)).not.toBeInTheDocument();
    expect(screen.queryByText('切换至此套餐')).not.toBeInTheDocument();
    expect(screen.queryByText('升级企业版')).not.toBeInTheDocument();
  });

  it('不渲染假发票 INV-2026-*，空列表显示暂无发票', () => {
    renderPanel();
    expect(screen.queryByText('INV-2026-0801')).not.toBeInTheDocument();
    expect(screen.getByText('暂无发票')).toBeInTheDocument();
  });

  it('真实发票在无收据时不假装可下载', () => {
    invoicesState.data = {
      invoices: [{
        id: 'inv-real',
        invoiceNumber: 'in_123',
        period: '2026-08',
        description: 'Growth',
        amountCents: 19900,
        status: 'paid',
        date: '2026-08-01',
        receiptPdfUrl: null,
      }],
    };
    renderPanel();
    expect(screen.getByText('in_123')).toBeInTheDocument();
    expect(screen.getByText('$199.00')).toBeInTheDocument();
    expect(screen.getByText('无收据')).toBeInTheDocument();
    expect(screen.queryByText('下载 PDF')).not.toBeInTheDocument();
  });

  it('有收据链接时才给出下载', () => {
    invoicesState.data = {
      invoices: [{
        id: 'inv-pdf',
        invoiceNumber: 'in_pdf',
        period: '2026-08',
        description: 'Essential',
        amountCents: 9900,
        status: 'paid',
        date: '2026-08-01',
        receiptPdfUrl: 'https://files.stripe.com/receipt.pdf',
      }],
    };
    renderPanel();
    const link = screen.getByRole('link', { name: '下载 PDF' });
    expect(link).toHaveAttribute('href', 'https://files.stripe.com/receipt.pdf');
  });

  it('past_due Essential 不会显示成 active Growth', () => {
    billingState.data = {
      billing: {
        ...essentialTrial(),
        plan: 'essential',
        subscriptionStatus: 'past_due',
        trialing: false,
        trialEndsAt: null,
      },
      autoTopup: null,
    };
    renderPanel();
    expect(screen.getAllByText(/基础版 \(Essential\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已逾期/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/增长旗舰版 \(Growth\) · 订阅生效中/)).not.toBeInTheDocument();
  });

  it('门户缺少 URL 时显示错误，不 toast 成功', async () => {
    portalMutate.mockResolvedValue({ url: null });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: '管理订阅与支付' }));
    await waitFor(() => {
      expect(toast.danger).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(portalMutate).toHaveBeenCalledWith('/settings?tab=billing');
    open.mockRestore();
  });

  it('门户有 URL 时打开 Stripe，不声称套餐已变更', async () => {
    portalMutate.mockResolvedValue({ url: 'https://billing.stripe.com/p/session_1' });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: '管理订阅与支付' }));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        'https://billing.stripe.com/p/session_1',
        '_blank',
        'noopener,noreferrer',
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/已成功切换/)).not.toBeInTheDocument();
    open.mockRestore();
  });

  it('hasPaymentMethod 为真但没有标签时仍不当成未绑卡', () => {
    billingState.data = {
      billing: essentialTrial({
        hasPaymentMethod: true,
        paymentMethodLabel: null,
      }),
      autoTopup: null,
    };
    renderPanel();
    expect(screen.getByText('已绑定支付方式')).toBeInTheDocument();
    expect(screen.queryByText('尚未绑定银行卡')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加支付方式' })).not.toBeInTheDocument();
  });

  it('已有支付方式时如实显示标签，不提供绑卡按钮', () => {
    billingState.data = {
      billing: essentialTrial({
        hasPaymentMethod: true,
        paymentMethodLabel: 'Visa ···· 4242',
      }),
      autoTopup: null,
    };
    renderPanel();
    expect(screen.getByText('支付方式: Visa ···· 4242')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加支付方式' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '管理订阅与支付' })).toBeInTheDocument();
  });

  it('没有支付方式时绑卡走真实 setup 接口，缺 URL 不当成功', async () => {
    paymentMethodMutate.mockResolvedValue({ url: null });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    });
    renderPanel();
    expect(screen.getByText('尚未绑定银行卡')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '添加支付方式' }));
    await waitFor(() => {
      expect(paymentMethodMutate).toHaveBeenCalledWith('/settings?tab=billing');
    });
    expect(toast.danger).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('绑卡接口返回 Stripe URL 才跳转托管页', async () => {
    paymentMethodMutate.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test_setup' });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: '添加支付方式' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_setup');
    });
    expect(toast.success).not.toHaveBeenCalled();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it.each([
    ['credit', '购买 $50 AI 积分'],
    ['voice_minute', '购买 $50 语音分钟'],
  ] as const)('%s 充值无论是否绑卡都跳转 Stripe 确认，不提前报成功', async (unit, label) => {
    const url = 'https://checkout.stripe.com/c/pay/cs_test_topup';
    topupMutate.mockResolvedValue({ url, sessionId: 'cs_test_topup' });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true, value: { ...original, assign },
    });
    try {
      for (const hasPaymentMethod of [false, true]) {
        billingState.data = {
          billing: essentialTrial({ hasPaymentMethod }), autoTopup: null,
        };
        const view = renderPanel();
        await userEvent.click(screen.getByRole('button', { name: label }));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(url));
        expect(topupMutate).toHaveBeenLastCalledWith(unit);
        expect(toast.success).not.toHaveBeenCalled();
        expect(billingState.refetch).not.toHaveBeenCalled();
        view.unmount();
        assign.mockClear();
      }
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('充值缺少 Stripe URL 时显示错误，不报充值成功', async () => {
    topupMutate.mockResolvedValue({ url: null, sessionId: 'cs_test_topup' });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: '购买 $50 AI 积分' }));
    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(billingState.refetch).not.toHaveBeenCalled();
  });

  it('充值失败不会把已购余额提前加上去', async () => {
    billingState.data = {
      billing: essentialTrial({
        hasPaymentMethod: true,
        paymentMethodLabel: 'Visa ···· 4242',
        quotas: [
          quota('credit', 12, 150, { balance: 0 }),
          quota('voice_minute', 3, 20, { balance: 0 }),
        ],
      }),
      autoTopup: null,
    };
    topupMutate.mockRejectedValue(new Error('card_declined'));
    renderPanel();
    expect(screen.getAllByText('已购余额: 0').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '购买 $50 AI 积分' }));
    await waitFor(() => {
      expect(toast.danger).toHaveBeenCalled();
    });
    expect(screen.getAllByText('已购余额: 0').length).toBeGreaterThan(0);
    expect(screen.queryByText('已购余额: 1000')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('自动续充显示服务端已保存的开关，而不是本地默认', () => {
    billingState.data = {
      billing: essentialTrial({
        quotas: [
          quota('credit', 12, 150, {
            autoTopup: { enabled: true, thresholdUnits: 50, failures: 0, lastAt: null },
          }),
          quota('voice_minute', 3, 20, {
            autoTopup: { enabled: false, thresholdUnits: 20, failures: 0, lastAt: null },
          }),
        ],
      }),
      autoTopup: null,
    };
    renderPanel();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
    expect(screen.getByText(/余额低于 50 时自动充 \$50/)).toBeInTheDocument();
    expect(screen.getByText(/余额低于 20 时自动充 \$50/)).toBeInTheDocument();
  });

  it('自动续充保存成功后更新真实状态', async () => {
    autoTopupMutate.mockResolvedValue({
      unit: 'credit',
      enabled: true,
      thresholdUnits: 50,
      failuresReset: false,
    });
    const { rerender } = renderPanel();
    const creditBox = screen.getAllByRole('checkbox')[1]!;
    expect(creditBox).not.toBeChecked();
    await userEvent.click(creditBox);
    await waitFor(() => {
      expect(autoTopupMutate).toHaveBeenCalledWith({
        unit: 'credit',
        enabled: true,
        thresholdUnits: 50,
      });
    });
    rerender(
      <LanguageProvider>
        <BillingPanel />
      </LanguageProvider>,
    );
    expect(screen.getAllByRole('checkbox')[1]).toBeChecked();
    expect(toast.success).toHaveBeenCalled();
    expect(billingState.refetch).toHaveBeenCalled();
  });

  it('自动续充保存失败时界面不假装已保存', async () => {
    autoTopupMutate.mockRejectedValue(new Error('save_failed'));
    renderPanel();
    const creditBox = screen.getAllByRole('checkbox')[1]!;
    expect(creditBox).not.toBeChecked();
    await userEvent.click(creditBox);
    await waitFor(() => {
      expect(toast.danger).toHaveBeenCalled();
    });
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Stripe 门户仍是唯一的套餐管理动作', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '管理订阅与支付' })).toBeInTheDocument();
    expect(screen.queryByText('切换至此套餐')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Essential/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Growth/ })).not.toBeInTheDocument();
  });
});

/**
 * 订阅码付费的门店（迁移 0120）。
 *
 * 这一组验的是**界面必须分叉**的那几处：给一个没有 Stripe 客户的老板
 * 一个「管理订阅」按钮，他点开的是一个 404；跟他说「未绑定支付方式」，
 * 说的是一件他从来没答应过的事。
 */
describe('BillingPanel 订阅码付费', () => {
  const licensed = (over: Partial<BillingView> = {}): BillingView => essentialTrial({
    subscriptionStatus: 'active',
    trialing: false,
    trialEndsAt: null,
    billingSource: 'license',
    licensePeriodEnd: '2026-12-31T23:59:59.000Z',
    currentPeriodEnd: '2026-12-31T23:59:59.000Z',
    hasPaymentMethod: false,
    ...over,
  });

  beforeEach(() => {
    toast.success.mockReset();
    toast.danger.mockReset();
    redeemMutate.mockReset();
    billingState.isLoading = false;
    invoicesState.isLoading = false;
    invoicesState.data = { invoices: [] };
    billingState.data = { billing: licensed(), autoTopup: null };
  });

  it('人工开通允许绑卡，但不显示尚未开通的 Stripe 订阅门户', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: '管理订阅与支付' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加支付方式' })).toBeInTheDocument();
    expect(screen.getByText(/尚未绑定银行卡/)).toBeInTheDocument();
    expect(screen.getByText(/由 GenieFront 直接开通/)).toBeInTheDocument();
  });

  it('显示服务有效期，而不是「自动续费」', () => {
    renderPanel();
    expect(screen.getAllByText(/服务有效期至 2026-12-31/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/下次续费/)).not.toBeInTheDocument();
  });

  it('到期显示「已到期」与只读说明，且兑换入口仍然可用', () => {
    billingState.data = {
      billing: licensed({ subscriptionStatus: 'expired' }),
      autoTopup: null,
    };
    renderPanel();
    expect(screen.getAllByText(/已到期/).length).toBeGreaterThan(0);
    expect(screen.getByText(/当前为只读/)).toBeInTheDocument();
    // ⭐ 冻结时唯一还该能做的写操作就是把冻结解决掉
    expect(screen.getByLabelText('兑换订阅码')).toBeEnabled();
  });

  it('兑换订阅码成功后显示新的有效期', async () => {
    redeemMutate.mockResolvedValue({
      kind: 'subscription', codePrefix: 'GF-3F7K', plan: 'growth',
      periodEnd: '2027-03-31T23:59:59.000Z',
      unit: null, amount: null, balanceAfter: null, invoiceId: 'inv-1',
    });
    renderPanel();
    await userEvent.type(screen.getByLabelText('兑换订阅码'), 'GF-3F7K-ABCDE-FGHJK-MNPQR');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    await waitFor(() => {
      expect(screen.getByText(/兑换成功，服务有效期至 2027-03-31/)).toBeInTheDocument();
    });
  });

  it('兑换额度包成功后说清加了多少额度', async () => {
    redeemMutate.mockResolvedValue({
      kind: 'quota_pack', codePrefix: 'GF-9K2M', plan: null, periodEnd: null,
      unit: 'voice_minute', amount: 200, balanceAfter: 200, invoiceId: null,
    });
    renderPanel();
    await userEvent.type(screen.getByLabelText('兑换订阅码'), 'GF-9K2M-ABCDE-FGHJK-MNPQR');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    await waitFor(() => {
      expect(screen.getByText(/已到账 200 分钟 AI 通话时长/)).toBeInTheDocument();
    });
  });

  /**
   * ⚠️ 三种失败必须说三句不同的话。合成一句「兑换失败」的话，
   * 一个正在被 Stripe 扣款的老板会一直重试一张本来就对的码。
   */
  it('码无效 / 限频 / 还在 Stripe 上，三句话各不相同', async () => {
    redeemMutate.mockRejectedValue({
      code: 'VALIDATION_FAILED', details: { reason: 'code_invalid' },
    });
    const first = renderPanel();
    await userEvent.type(screen.getByLabelText('兑换订阅码'), 'GF-BADBAD-BADBAD');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    await waitFor(() => {
      expect(screen.getByText(/这个码无效、已被使用或已过期/)).toBeInTheDocument();
    });
    first.unmount();

    redeemMutate.mockRejectedValue({ code: 'RATE_LIMITED', details: {} });
    const second = renderPanel();
    await userEvent.type(screen.getByLabelText('兑换订阅码'), 'GF-BADBAD-BADBAD');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    await waitFor(() => {
      expect(screen.getByText(/尝试次数过多/)).toBeInTheDocument();
    });
    second.unmount();

    redeemMutate.mockRejectedValue({
      code: 'VALIDATION_FAILED', details: { reason: 'stripe_active_switch_required' },
    });
    renderPanel();
    await userEvent.type(screen.getByLabelText('兑换订阅码'), 'GF-GOODCODE-HERE1');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    await waitFor(() => {
      expect(screen.getByText(/当前由 Stripe 订阅管理/)).toBeInTheDocument();
    });
  });

  it('Stripe 付费的店照样有客户门户入口（没被误伤）', () => {
    billingState.data = { billing: essentialTrial(), autoTopup: null };
    renderPanel();
    expect(screen.getByRole('button', { name: '管理订阅与支付' })).toBeInTheDocument();
  });
});

it('separates trial minutes from redeemed minutes and never labels the trial as monthly', () => {
  billingState.data.billing = essentialTrial({ plan: 'voice_booking', quotas: [quota('voice_minute', 6, 20, { balance: 200 })] });
  renderPanel();
  expect(screen.getByText(/试用额度/)).toBeVisible();
  expect(screen.getByText('额外额度')).toBeVisible();
  expect(screen.getByText('剩余 14 分钟')).toBeVisible();
  expect(screen.getByText('剩余 200 分钟')).toBeVisible();
  expect(screen.queryByText(/次月 1 日自动重置/)).not.toBeInTheDocument();
});
