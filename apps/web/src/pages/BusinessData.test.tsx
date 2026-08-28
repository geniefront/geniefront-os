import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserRouter } from "react-router-dom";
import { LanguageProvider } from "@/LanguageContext";
import { BusinessData } from "./BusinessData";

const sessionState = {
  membershipId: "mem-1",
  orgId: "org-1",
  locationId: "loc-1",
  can: (_: string) => true,
  isOnline: true,
};

vi.mock("@/lib/session", () => ({
  useSession: () => sessionState,
}));

const mockAnalytics: any = {
  revenue: {
    data: {
      trends: [],
      byCategory: [],
      byPaymentMethod: { cashCents: 0, cardCents: 0, giftCardCents: 0, externalCents: 0 },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  customers: {
    data: {
      totalVisits: 0,
      newCustomerVisits: 0,
      returningCustomerVisits: 0,
      retentionRateBp: 0,
      averageTicketCents: 0,
      sleepingCustomerCount: 0,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  staff: {
    data: { rows: [] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  reviews: {
    data: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  heatmap: {
    data: {
      matrix: {},
      peakHour: "",
      avgCapacityUtilizationBp: 0,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  rfm: {
    data: {
      cohorts: {
        vip: { count: 0, revenueCents: 0, avgTicketCents: 0, visitFrequency: 0 },
        active: { count: 0, revenueCents: 0, avgTicketCents: 0, visitFrequency: 0 },
        new: { count: 0, avgFirstTicketCents: 0, secondVisitRateBp: 0 },
        sleeping: { count: 0, atRiskRevenueCents: 0, inactiveDaysThreshold: 60 },
      },
      channels: [],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  topServices: {
    data: { services: [] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  copilot: {
    data: { highlights: [], risks: [], actions: [], generatedAt: "" },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
};

vi.mock("@/features/analytics/api", () => ({
  useRevenueTrendsQuery: () => mockAnalytics.revenue,
  useCustomerRetentionQuery: () => mockAnalytics.customers,
  useStaffAnalyticsQuery: () => mockAnalytics.staff,
  useReviewsSummaryQuery: () => mockAnalytics.reviews,
  useHeatmapQuery: () => mockAnalytics.heatmap,
  useRfmCustomersQuery: () => mockAnalytics.rfm,
  useTopServicesQuery: () => mockAnalytics.topServices,
  useCopilotSummaryQuery: () => mockAnalytics.copilot,
  useGenerateCopilotSummary: () => ({ isPending: false, mutate: vi.fn() }),
}));

function renderComponent() {
  return render(
    <BrowserRouter>
      <LanguageProvider>
        <BusinessData />
      </LanguageProvider>
    </BrowserRouter>
  );
}

beforeEach(() => {
  sessionState.can = (perm: string) => perm === "report.view";
  mockAnalytics.revenue.isError = false;
  mockAnalytics.revenue.error = null;
  mockAnalytics.revenue.data = {
    trends: [],
    byCategory: [],
    byPaymentMethod: { cashCents: 0, cardCents: 0, giftCardCents: 0, externalCents: 0 },
  };
  mockAnalytics.customers.data = {
    totalVisits: 0,
    newCustomerVisits: 0,
    returningCustomerVisits: 0,
    retentionRateBp: 0,
    averageTicketCents: 0,
    sleepingCustomerCount: 0,
  };
  mockAnalytics.heatmap.data = {
    matrix: {},
    peakHour: "",
    avgCapacityUtilizationBp: 0,
  };
  mockAnalytics.topServices.data = { services: [] };
  mockAnalytics.staff.data = { rows: [] };
  mockAnalytics.copilot.data = { highlights: [], risks: [], actions: [], generatedAt: "" };
});

describe("BusinessData 权限与空数据防伪造测试", () => {
  it("当账号无 report.view 权限时拦截并显示无权限提示，不渲染任何假数据", () => {
    sessionState.can = () => false;

    renderComponent();

    expect(screen.getByText("当前账号没有查看经营报表的权限")).toBeInTheDocument();
    expect(
      screen.getByText(/经营多维数据与商业智能报表仅限店主或具备 report.view 权限的管理员查看/)
    ).toBeInTheDocument();

    // 确保没有伪造的假数据
    expect(screen.queryByText("$15,890.00")).not.toBeInTheDocument();
    expect(screen.queryByText("286")).not.toBeInTheDocument();
    expect(screen.queryByText("76.5%")).not.toBeInTheDocument();
    expect(screen.queryByText("84.2%")).not.toBeInTheDocument();
  });

  it("当接口返回 403 时拦截并显示无权限提示", () => {
    sessionState.can = () => true;
    mockAnalytics.revenue.isError = true;
    mockAnalytics.revenue.error = { status: 403, message: "Forbidden" } as any;

    renderComponent();

    expect(screen.getByText("当前账号没有查看经营报表的权限")).toBeInTheDocument();
    expect(screen.queryByText("$15,890.00")).not.toBeInTheDocument();
  });

  it("当有权限且数据为空时，渲染真实的 $0.00 和 0% 指标及空状态，不使用硬编码伪造数据", () => {
    renderComponent();

    // GMV 真实显示 $0.00 而不是 $15,890.00
    expect(screen.getAllByText("$0.00")).toHaveLength(2);
    expect(screen.queryByText("$15,890.00")).not.toBeInTheDocument();

    // 客流与复购率显示真实 0 和 0.0%
    expect(screen.getAllByText("0.0%")).toHaveLength(2);
    expect(screen.queryByText("76.5%")).not.toBeInTheDocument();

    // 空状态提示
    expect(screen.getByText("当前区间暂无经营数据")).toBeInTheDocument();
    expect(screen.getByText("暂无高峰热力分布数据")).toBeInTheDocument();
  });

  it("当有权限且接口返回正常数据时，正确渲染实际指标", () => {
    mockAnalytics.revenue.data = {
      trends: [
        {
          date: "2026-08-28",
          serviceRevenueCents: 50000,
          retailRevenueCents: 10000,
          giftCardSalesCents: 5000,
          tipCents: 5000,
          discountCents: 0,
          netCents: 65000,
        },
      ],
      byCategory: [
        { categoryId: "c1", name: "美甲手部护理", revenueCents: 50000, percentBp: 10000 },
      ],
      byPaymentMethod: { cashCents: 20000, cardCents: 45000, giftCardCents: 0, externalCents: 0 },
    };
    mockAnalytics.customers.data = {
      totalVisits: 15,
      newCustomerVisits: 5,
      returningCustomerVisits: 10,
      retentionRateBp: 6670,
      averageTicketCents: 4333,
      sleepingCustomerCount: 2,
    };
    mockAnalytics.heatmap.data = {
      matrix: {
        周一: [40, 50, 60, 70, 80, 50],
      },
      peakHour: "周一 18:00",
      avgCapacityUtilizationBp: 6200,
    };

    renderComponent();

    expect(screen.getByText("$650.00")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("$43.33")).toBeInTheDocument();
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("62.0%")).toBeInTheDocument();
  });
});
