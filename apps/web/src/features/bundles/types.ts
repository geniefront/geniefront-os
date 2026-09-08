/**
 * 组合套餐（service bundle）前端类型 —— 与 apps/api 的
 * `queries/bundleCatalog.ts` / `queries/bundle.ts` / `commands/bundle.ts` 对齐。
 *
 * 组合套餐 = 一次消费里固定几个项目一起买、走固定组合价，当场展开成实际子项
 * 履约；与次卡（package，按次核销的预付资产）是两回事。
 */

export interface BundleComponentView {
  componentId: string;
  serviceId: string;
  serviceName: string;
  qty: number;
  seq: number;
  includedAddonIds: string[];
  listPriceCents: number;
  durationMin: number;
  serviceActive: boolean;
}

export interface BundleTemplateView {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  originalTotalCents: number;
  bundleDiscountCents: number;
  onlineBookable: boolean;
  active: boolean;
  version: number;
  sort: number;
  components: BundleComponentView[];
  fulfillable: boolean;
  instanceCount: number;
}

export interface BundleCatalogResponse {
  templates: BundleTemplateView[];
  availableServices: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
  availableAddons: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
}

/** `bundle.saveTemplate` 入参。`name` 五语言全填（i18nText）。 */
export interface SaveBundleTemplateInput {
  bundleId?: string;
  name: Record<string, string>;
  description?: Record<string, string> | null;
  priceCents: number;
  components: Array<{
    serviceId: string;
    qty: number;
    seq: number;
    includedAddonIds?: string[];
  }>;
  onlineBookable?: boolean;
  active?: boolean;
  sort?: number;
  /** 乐观锁：编辑时带上取到的 version。 */
  expectedVersion?: number;
}

export interface BundleQuoteRequestInput {
  bundleId: string;
  expectedVersion?: number;
  extraAddons?: Array<{ ref: string; attachToUnit: string; serviceId: string; qty?: number }>;
  extraDiscountCents?: number;
  extraDiscountKind?: 'manual' | 'coupon';
}

export interface BundleQuoteUnit {
  componentId: string;
  serviceId: string;
  seq: number;
  unitIndex: number;
  unitKey: string;
  listPriceCents: number;
  bundleNetCents: number;
  extraDiscountCents: number;
  netCents: number;
  durationMin: number;
  includedAddonIds: string[];
}

export interface BundleQuoteResult {
  bundleId: string;
  version: number;
  nameSnapshot: Record<string, string>;
  units: BundleQuoteUnit[];
  extraAddons: Array<{
    ref: string;
    attachToUnit: string;
    unitOrdinal: number;
    serviceId: string;
    qty: number;
    listPriceCents: number;
    extraDiscountCents: number;
    netCents: number;
    durationMin: number;
  }>;
  originalTotalCents: number;
  bundlePriceCents: number;
  bundleDiscountCents: number;
  extraAddonListTotalCents: number;
  extraDiscountCents: number;
  serviceNetTotalCents: number;
}
