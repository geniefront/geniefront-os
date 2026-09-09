/**
 * 开店向导「服务项目」步骤的行业预设（U01 / S5）。
 *
 * 少量、版本化、五语言的**纯静态数据** —— 和 `healthFormPresets.ts` 同思路：
 * 契约里放数据，Web 复用导出，不让 API 依赖 Web 包，也不调用 AI。
 *
 * 用法约束（前端实现，见 `features/setup/CatalogPresetPicker`）：
 *   · 切换行业只**预览新增项**，不覆盖已有目录、不动价格。
 *   · 用 `presetKey` 去重：某个 key 对应的项目名已在目录里（按显示名归一化
 *     比对 en / zh-Hans），就不再重复展示，重复点「加入」也不会重复建。
 *   · `basePriceCents` 是**起步参考价**，落库前老板可改；时长同理。
 *
 * `version` 在数据结构变化或价目重订时 +1，方便前端判断是否需要重新提示。
 */

/** 多语言显示文案（与 `healthFormPresets.ts` 同口径，键为 UI 语言码）。 */
export type LocalizedText = Record<string, string>;

export const CATALOG_PRESET_VERSION = 1;

/** 与 `catalog.saveService` 对齐的最小项目形状。 */
export interface CatalogPresetService {
  /** 稳定去重键。跨版本不变；换名不换 key。 */
  presetKey: string;
  name: LocalizedText;
  durationMin: number;
  /** 起步参考价（整数分）。落库前可改。 */
  basePriceCents: number;
  /** 加项：只能加在主项目上，不单独预约（对齐 sql/0035）。 */
  isAddon?: boolean;
}

export interface IndustryCatalogPreset {
  /** 门店 `businessType`。`mixed` 不给预设（综合店目录差异太大，手工建更准）。 */
  businessType: 'nail' | 'massage' | 'foot_spa' | 'lash' | 'scalp' | 'hair';
  name: LocalizedText;
  services: CatalogPresetService[];
}

const T = (
  zh: string, en: string, ko: string, es: string, vi: string,
): LocalizedText => ({ 'zh-Hans': zh, en, ko, es, vi });

export const INDUSTRY_CATALOG_PRESETS: IndustryCatalogPreset[] = [
  {
    businessType: 'nail',
    name: T('美甲 / 美足', 'Nails & Pedicure', '네일 & 페디큐어', 'Uñas y pedicura', 'Làm móng & chăm sóc chân'),
    services: [
      { presetKey: 'nail.classic_manicure', durationMin: 30, basePriceCents: 2500,
        name: T('经典修甲', 'Classic Manicure', '클래식 매니큐어', 'Manicura clásica', 'Làm móng tay cơ bản') },
      { presetKey: 'nail.gel_manicure', durationMin: 45, basePriceCents: 4000,
        name: T('凝胶美甲', 'Gel Manicure', '젤 매니큐어', 'Manicura en gel', 'Sơn gel móng tay') },
      { presetKey: 'nail.classic_pedicure', durationMin: 45, basePriceCents: 3500,
        name: T('经典修足', 'Classic Pedicure', '클래식 페디큐어', 'Pedicura clásica', 'Làm móng chân cơ bản') },
      { presetKey: 'nail.deluxe_pedicure', durationMin: 60, basePriceCents: 5500,
        name: T('豪华 SPA 修足', 'Deluxe Spa Pedicure', '디럭스 스파 페디큐어', 'Pedicura spa de lujo', 'Chăm sóc chân spa cao cấp') },
      { presetKey: 'nail.full_set_acrylic', durationMin: 75, basePriceCents: 6000,
        name: T('全套水晶甲', 'Acrylic Full Set', '아크릴 풀세트', 'Set completo de acrílico', 'Bộ móng bột hoàn chỉnh') },
      { presetKey: 'nail.gel_removal', durationMin: 15, basePriceCents: 1000, isAddon: true,
        name: T('卸甲', 'Gel Removal', '젤 제거', 'Retiro de gel', 'Tháo gel') },
    ],
  },
  {
    businessType: 'massage',
    name: T('按摩理疗', 'Massage Therapy', '마사지 테라피', 'Terapia de masaje', 'Trị liệu massage'),
    services: [
      { presetKey: 'massage.swedish_60', durationMin: 60, basePriceCents: 8000,
        name: T('瑞典式全身按摩 60 分钟', 'Swedish Massage 60 min', '스웨디시 마사지 60분', 'Masaje sueco 60 min', 'Massage Thụy Điển 60 phút') },
      { presetKey: 'massage.deep_tissue_60', durationMin: 60, basePriceCents: 9000,
        name: T('深层组织按摩 60 分钟', 'Deep Tissue Massage 60 min', '딥티슈 마사지 60분', 'Masaje de tejido profundo 60 min', 'Massage mô sâu 60 phút') },
      { presetKey: 'massage.deep_tissue_90', durationMin: 90, basePriceCents: 13000,
        name: T('深层组织按摩 90 分钟', 'Deep Tissue Massage 90 min', '딥티슈 마사지 90분', 'Masaje de tejido profundo 90 min', 'Massage mô sâu 90 phút') },
      { presetKey: 'massage.hot_stone', durationMin: 90, basePriceCents: 14000,
        name: T('热石按摩', 'Hot Stone Massage', '핫스톤 마사지', 'Masaje con piedras calientes', 'Massage đá nóng') },
      { presetKey: 'massage.prenatal', durationMin: 60, basePriceCents: 9500,
        name: T('孕期按摩', 'Prenatal Massage', '산전 마사지', 'Masaje prenatal', 'Massage cho bà bầu') },
      { presetKey: 'massage.aromatherapy_addon', durationMin: 0, basePriceCents: 1500, isAddon: true,
        name: T('香薰精油 +', 'Aromatherapy +', '아로마테라피 +', 'Aromaterapia +', 'Tinh dầu thơm +') },
    ],
  },
  {
    businessType: 'foot_spa',
    name: T('足疗 / 足浴', 'Foot Spa & Reflexology', '풋 스파 & 발 반사요법', 'Spa de pies y reflexología', 'Spa chân & bấm huyệt'),
    services: [
      { presetKey: 'foot_spa.reflexology_30', durationMin: 30, basePriceCents: 3500,
        name: T('足底反射按摩 30 分钟', 'Foot Reflexology 30 min', '발 반사요법 30분', 'Reflexología de pies 30 min', 'Bấm huyệt bàn chân 30 phút') },
      { presetKey: 'foot_spa.reflexology_60', durationMin: 60, basePriceCents: 6000,
        name: T('足底反射按摩 60 分钟', 'Foot Reflexology 60 min', '발 반사요법 60분', 'Reflexología de pies 60 min', 'Bấm huyệt bàn chân 60 phút') },
      { presetKey: 'foot_spa.foot_body_combo', durationMin: 90, basePriceCents: 8500,
        name: T('足疗 + 肩颈套餐', 'Foot + Back & Shoulder Combo', '발 + 어깨·등 세트', 'Combo pies + espalda y hombros', 'Combo chân + lưng vai') },
      { presetKey: 'foot_spa.herbal_soak', durationMin: 15, basePriceCents: 1200, isAddon: true,
        name: T('中药足浴 +', 'Herbal Foot Soak +', '한방 족욕 +', 'Remojo herbal de pies +', 'Ngâm chân thảo dược +') },
      { presetKey: 'foot_spa.hot_stone_feet', durationMin: 15, basePriceCents: 1500, isAddon: true,
        name: T('热石足部 +', 'Hot Stone Feet +', '핫스톤 발 +', 'Piedras calientes en pies +', 'Đá nóng bàn chân +') },
    ],
  },
  {
    businessType: 'lash',
    name: T('美睫 / 美眉', 'Lashes & Brows', '속눈썹 & 눈썹', 'Pestañas y cejas', 'Nối mi & chân mày'),
    services: [
      { presetKey: 'lash.classic_full_set', durationMin: 90, basePriceCents: 9000,
        name: T('经典单根睫毛全套', 'Classic Full Set', '클래식 풀세트', 'Set completo clásico', 'Nối mi classic toàn bộ') },
      { presetKey: 'lash.volume_full_set', durationMin: 120, basePriceCents: 13000,
        name: T('浓密睫毛全套', 'Volume Full Set', '볼륨 풀세트', 'Set completo volumen', 'Nối mi volume toàn bộ') },
      { presetKey: 'lash.fill_2wk', durationMin: 60, basePriceCents: 5500,
        name: T('两周补睫', '2-Week Fill', '2주 리터치', 'Relleno 2 semanas', 'Dặm mi 2 tuần') },
      { presetKey: 'lash.lash_lift', durationMin: 60, basePriceCents: 7000,
        name: T('睫毛翘翘', 'Lash Lift', '래쉬 리프트', 'Lifting de pestañas', 'Uốn mi') },
      { presetKey: 'lash.brow_lamination', durationMin: 45, basePriceCents: 6500,
        name: T('眉毛塑形', 'Brow Lamination', '눈썹 라미네이션', 'Laminado de cejas', 'Ép phồng chân mày') },
    ],
  },
  {
    businessType: 'scalp',
    name: T('头皮护理', 'Scalp Care', '두피 케어', 'Cuidado del cuero cabelludo', 'Chăm sóc da đầu'),
    services: [
      { presetKey: 'scalp.basic_treatment', durationMin: 45, basePriceCents: 6000,
        name: T('基础头皮护理', 'Basic Scalp Treatment', '기본 두피 관리', 'Tratamiento básico de cuero cabelludo', 'Chăm sóc da đầu cơ bản') },
      { presetKey: 'scalp.deep_detox', durationMin: 75, basePriceCents: 9500,
        name: T('深层头皮净化', 'Deep Detox Scalp Treatment', '딥 디톡스 두피 관리', 'Detox profundo de cuero cabelludo', 'Thải độc da đầu chuyên sâu') },
      { presetKey: 'scalp.scalp_massage_30', durationMin: 30, basePriceCents: 4000,
        name: T('头皮按摩 30 分钟', 'Scalp Massage 30 min', '두피 마사지 30분', 'Masaje de cuero cabelludo 30 min', 'Massage da đầu 30 phút') },
      { presetKey: 'scalp.hair_loss_care', durationMin: 90, basePriceCents: 12000,
        name: T('防脱育发护理', 'Hair Loss Care', '탈모 케어', 'Cuidado anticaída', 'Chăm sóc ngăn rụng tóc') },
    ],
  },
  {
    businessType: 'hair',
    name: T('美发', 'Hair Salon', '헤어 살롱', 'Peluquería', 'Làm tóc'),
    services: [
      { presetKey: 'hair.womens_cut', durationMin: 45, basePriceCents: 5500,
        name: T('女士剪发', "Women's Haircut", '여성 커트', 'Corte de mujer', 'Cắt tóc nữ') },
      { presetKey: 'hair.mens_cut', durationMin: 30, basePriceCents: 3500,
        name: T('男士剪发', "Men's Haircut", '남성 커트', 'Corte de hombre', 'Cắt tóc nam') },
      { presetKey: 'hair.blowout', durationMin: 45, basePriceCents: 4500,
        name: T('吹造型', 'Blowout & Style', '드라이 스타일링', 'Brushing y peinado', 'Sấy tạo kiểu') },
      { presetKey: 'hair.single_color', durationMin: 120, basePriceCents: 9500,
        name: T('单色染发', 'Single-Process Color', '단일 염색', 'Color en un proceso', 'Nhuộm một màu') },
      { presetKey: 'hair.highlights', durationMin: 150, basePriceCents: 14000,
        name: T('挑染', 'Partial Highlights', '부분 하이라이트', 'Mechas parciales', 'Highlight từng phần') },
      { presetKey: 'hair.deep_condition', durationMin: 20, basePriceCents: 2000, isAddon: true,
        name: T('深层护发 +', 'Deep Conditioning +', '딥 컨디셔닝 +', 'Acondicionamiento profundo +', 'Hấp dầu +') },
    ],
  },
];

/** 按 businessType 取行业预设；`mixed` / 未知返回 null。 */
export function catalogPresetForBusinessType(
  businessType: string | null | undefined,
): IndustryCatalogPreset | null {
  return INDUSTRY_CATALOG_PRESETS.find((p) => p.businessType === businessType) ?? null;
}
