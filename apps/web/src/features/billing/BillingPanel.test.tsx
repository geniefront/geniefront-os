import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/LanguageContext';
import { BillingPanel } from './BillingPanel';
import type { BillingView, BillingInvoiceItem } from './types';

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
};
const invoicesState = {
  data: { invoices: [] as BillingInvoiceItem[] },
  isLoading: false,
};
const portalMutate = vi.fn();
const portalState = {
  isPending: false,
  mutateAsync: (...args: unknown[]) => portalMutate(...args),
};

vi.mock('./api', () => ({
  useBillingQuery: () => billingState,
  useInvoicesQuery: () => invoicesState,
  useCreateBillingPortalSession: () => portalState,
}));

function quota(unit: 'credit' | 'voice_minute', used: number, total: number) {
  return {
    unit,
    included: { used, total, remaining: Math.max(0, total - used) },
    balance: 0,
    unitsPerTopup: unit === 'credit' ? 1000 : 200,
    autoTopup: { enabled: false, thresholdUnits: 50, failures: 0, lastAt: null },
    usedThisMonth: used,
  };
}

function essentialTrial(): BillingView {
  return {
    plan: 'essential',
    subscriptionStatus: 'trialing',
    currentPeriodEnd: '2026-09-07T00:00:00.000Z',
    hasSubscription: true,
    trialEndsAt: '2026-09-07T00:00:00.000Z',
    trialing: true,
    hasPaymentMethod: false,
    paymentMethodLabel: null,
    topupPriceCents: 5000,
    quotas: [quota('credit', 12, 150), quota('voice_minute', 3, 20)],
    recent: [],
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
});
