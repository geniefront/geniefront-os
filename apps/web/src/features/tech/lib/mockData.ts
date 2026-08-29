/**
 * 技师端 Mock 数据中心与交互状态管理。
 *
 * 为前端提供全功能、高保真的离线/模拟运行支持，支持实时响应打卡、
 * 接单/拒单顺延、倒计时开始/完成、服务加项、修改 PIN 与排班偏好等交互。
 */

export interface MockStanding {
  membershipId: string;
  name: string;
  state: 'in_service' | 'available' | 'on_break' | 'off';
  consumedBp: number;
  isMe: boolean;
}

export interface MockAddonItem {
  id: string;
  name: Record<string, string>;
  priceCents: number;
  durationMin: number;
}

export interface MockTaskItem {
  ticketId: string;
  ticketItemId: string;
  serviceName: string;
  durationMin: number;
  startedAt: string | null;
  state: 'waiting' | 'in_service';
  resourceName?: string;
  customerName: string;
  customerPhone: string;
  isRequest?: boolean;
  alerts: string[];
  addons: MockAddonItem[];
}

export interface MockLedgerRecord {
  id: string;
  ticketItemId: string;
  serviceName: string;
  customerName: string;
  durationMin: number;
  timeStr: string;
  dateStr: string;
  commissionCents: number;
  tipCents: number;
  totalCents: number;
  isRequest?: boolean;
}

export interface MockShiftItem {
  dayIndex: number;
  dateStr: string;
  startMin: number;
  endMin: number;
  breakMin: number;
  status: 'published' | 'off' | 'draft';
}

export interface MockTechStore {
  // 个人信息
  profile: {
    staffId: string;
    name: string;
    employeeNo: string;
    roleKey: string;
    level: string;
    soundEnabled: boolean;
    wakeLockEnabled: boolean;
    expectedStart: string;
    expectedEnd: string;
  };
  // 今日工作状态
  workbench: {
    onDuty: boolean;
    onBreak: boolean;
    clockInTime: string | null;
    workedMinutes: number;
    doneCount: number;
    rotation: {
      position: number;
      isNextUp: boolean;
      consumedBp: number;
    };
    standings: MockStanding[];
    currentTask: MockTaskItem | null;
    nextTask: {
      serviceName: string;
      durationMin: number;
      customerName: string;
      resourceName?: string;
    } | null;
    earnings: {
      commissionCents: number;
      tipCashCents: number;
      tipCardCents: number;
      cashTipOwedCents: number;
      serviceRevenueCents: number;
    };
  };
  // 可加项目库
  addonCatalog: MockAddonItem[];
  // 历史做工流水
  historyRecords: MockLedgerRecord[];
  // 周排班
  weeklyShifts: MockShiftItem[];
}

const STORAGE_KEY = 'gf_tech_mock_store_v1';

const DEFAULT_STORE: MockTechStore = {
  profile: {
    staffId: 'st_108',
    name: 'Linda Chen',
    employeeNo: 'T-108',
    roleKey: 'senior_tech',
    level: 'Senior Esthetician · 资深美容美睫师',
    soundEnabled: true,
    wakeLockEnabled: true,
    expectedStart: '10:00',
    expectedEnd: '19:30',
  },
  workbench: {
    onDuty: true,
    onBreak: false,
    clockInTime: '09:30',
    workedMinutes: 295,
    doneCount: 3,
    rotation: {
      position: 1,
      isNextUp: true,
      consumedBp: 15000,
    },
    standings: [
      { membershipId: 'st_108', name: 'Linda (我)', state: 'in_service', consumedBp: 15000, isMe: true },
      { membershipId: 'st_102', name: 'Amy Wang', state: 'available', consumedBp: 10000, isMe: false },
      { membershipId: 'st_103', name: 'Kevin Zhang', state: 'available', consumedBp: 20000, isMe: false },
      { membershipId: 'st_104', name: 'Jenny Liu', state: 'on_break', consumedBp: 25000, isMe: false },
      { membershipId: 'st_105', name: 'Sarah Wu', state: 'in_service', consumedBp: 30000, isMe: false },
    ],
    currentTask: {
      ticketId: 'tkt_8821',
      ticketItemId: 'item_101',
      serviceName: 'HydraFacial 深层水光净肤 + 舒缓镇静',
      durationMin: 60,
      startedAt: new Date(Date.now() - 38 * 60 * 1000).toISOString(),
      state: 'in_service',
      resourceName: 'VIP 护理室 2 (水光专区)',
      customerName: 'Emily Watson',
      customerPhone: '917-***-5821',
      isRequest: true,
      alerts: [
        '严重水杨酸及高浓度果酸过敏史，请使用温和玻尿酸导入溶液。',
        '两颊及鼻翼皮肤角质层较薄，避免强力负压吸头停留过久。',
      ],
      addons: [
        {
          id: 'add_01',
          name: {
            'zh-Hans': 'LED 蓝光舒缓镇静面罩 (15m)',
            en: 'LED Calming Blue Light Mask (15m)',
            ko: 'LED 진정 블루라이트 마스크 (15분)',
            vi: 'Mặt nạ ánh sáng xanh LED làm dịu (15p)',
            es: 'Máscara LED calmante luz azul (15m)',
          },
          priceCents: 3500,
          durationMin: 15,
        },
      ],
    },
    nextTask: {
      serviceName: 'Aromatherapy Body Massage 芳香全身精油 SPA',
      durationMin: 75,
      customerName: 'Jessica Taylor',
      resourceName: 'SPA 芳疗房 1',
    },
    earnings: {
      commissionCents: 18600,
      tipCashCents: 4500,
      tipCardCents: 3800,
      cashTipOwedCents: 4500,
      serviceRevenueCents: 42000,
    },
  },
  addonCatalog: [
    {
      id: 'add_01',
      name: {
        'zh-Hans': 'LED 蓝光舒缓镇静面罩 (15m)',
        en: 'LED Calming Blue Light Mask (15m)',
        ko: 'LED 진정 블루라이트 마스크 (15분)',
        vi: 'Mặt nạ ánh sáng xanh LED làm dịu (15p)',
        es: 'Máscara LED calmante luz azul (15m)',
      },
      priceCents: 3500,
      durationMin: 15,
    },
    {
      id: 'add_02',
      name: {
        'zh-Hans': '眼部 RF 射频淡纹紧致提拉 (20m)',
        en: 'Eye Contour RF Tightening Lift (20m)',
        ko: '눈가 RF 고주파 리프팅 (20분)',
        vi: 'Nâng cơ xóa nhăn mắt RF (20p)',
        es: 'Lifting reafirmante de ojos RF (20m)',
      },
      priceCents: 4800,
      durationMin: 20,
    },
    {
      id: 'add_03',
      name: {
        'zh-Hans': '天鹅颈紧致淡纹滋养护理 (20m)',
        en: 'Neck & Décolleté Nourishing Treatment (20m)',
        ko: '넥 & 데콜테 탄력 케어 (20분)',
        vi: 'Chăm sóc cổ & ngực chuyên sâu (20p)',
        es: 'Tratamiento nutritivo de cuello y escote (20m)',
      },
      priceCents: 5200,
      durationMin: 20,
    },
    {
      id: 'add_04',
      name: {
        'zh-Hans': '升级特调纯植物芳疗精油',
        en: 'Organic Pure Plant Essential Oil Upgrade',
        ko: '유기농 천연 아로마 에센셜 오일 업그레이드',
        vi: 'Nâng cấp tinh dầu thiên nhiên cao cấp',
        es: 'Mejora con aceite esencial botánico orgánico',
      },
      priceCents: 2500,
      durationMin: 0,
    },
    {
      id: 'add_05',
      name: {
        'zh-Hans': '深层滋润胶原蛋白手膜护理',
        en: 'Collagen Deep Moisture Hand Treatment',
        ko: '콜라겐 핸드 마스크 케어',
        vi: 'Ủ dưỡng ẩm tay collagen',
        es: 'Tratamiento de colágeno hidratante para manos',
      },
      priceCents: 1800,
      durationMin: 15,
    },
    {
      id: 'add_06',
      name: {
        'zh-Hans': '头部芳香减压放松按摩 (15m)',
        en: 'Aromatic Scalp Stress Relief Massage (15m)',
        ko: '두피 아로마 릴랙스 마사지 (15분)',
        vi: 'Massage thư giãn da đầu (15p)',
        es: 'Masaje relajante aromático para cuero cabelludo (15m)',
      },
      priceCents: 3000,
      durationMin: 15,
    },
  ],
  historyRecords: [
    {
      id: 'rec_01',
      ticketItemId: 'item_1001',
      serviceName: 'HydraFacial 水光深层净肤',
      customerName: 'Emily Watson',
      durationMin: 60,
      timeStr: '15:30 - 16:30',
      dateStr: new Date().toISOString().slice(0, 10),
      commissionCents: 6500,
      tipCents: 3000,
      totalCents: 15000,
      isRequest: true,
    },
    {
      id: 'rec_02',
      ticketItemId: 'item_1002',
      serviceName: '日式睫毛嫁接 (自然芭比款)',
      customerName: 'Chloe Bennett',
      durationMin: 90,
      timeStr: '13:00 - 14:30',
      dateStr: new Date().toISOString().slice(0, 10),
      commissionCents: 7200,
      tipCents: 3500,
      totalCents: 16000,
      isRequest: false,
    },
    {
      id: 'rec_03',
      ticketItemId: 'item_1003',
      serviceName: '光子嫩肤美白管理 + 胶原面膜',
      customerName: 'Sophia Miller',
      durationMin: 45,
      timeStr: '10:30 - 11:15',
      dateStr: new Date().toISOString().slice(0, 10),
      commissionCents: 4900,
      tipCents: 1800,
      totalCents: 11000,
      isRequest: true,
    },
    {
      id: 'rec_04',
      ticketItemId: 'item_1004',
      serviceName: '全身芳香精油 SPA (60m)',
      customerName: 'Anna Taylor',
      durationMin: 60,
      timeStr: '16:00 - 17:00',
      dateStr: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      commissionCents: 5800,
      tipCents: 2500,
      totalCents: 13000,
      isRequest: false,
    },
    {
      id: 'rec_05',
      ticketItemId: 'item_1005',
      serviceName: '深层毛孔清洁小气泡',
      customerName: 'Mia Davis',
      durationMin: 45,
      timeStr: '14:00 - 14:45',
      dateStr: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      commissionCents: 4200,
      tipCents: 2000,
      totalCents: 9800,
      isRequest: false,
    },
    {
      id: 'rec_06',
      ticketItemId: 'item_1006',
      serviceName: '眼部热玛吉提拉护理',
      customerName: 'Olivia Wilson',
      durationMin: 60,
      timeStr: '11:00 - 12:00',
      dateStr: new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10),
      commissionCents: 8500,
      tipCents: 4000,
      totalCents: 22000,
      isRequest: true,
    },
  ],
  weeklyShifts: (() => {
    const days: MockShiftItem[] = [];
    const now = new Date();
    const curDay = now.getDay();
    const mondayOffset = curDay === 0 ? -6 : 1 - curDay;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const isOff = i === 2 || i === 6; // 周三、周日休息
      days.push({
        dayIndex: i,
        dateStr: d.toISOString().slice(0, 10),
        startMin: 600, // 10:00
        endMin: 1170,  // 19:30
        breakMin: 60,
        status: isOff ? 'off' : 'published',
      });
    }
    return days;
  })(),
};

/** 读取 Mock 状态 */
export function getMockStore(): MockTechStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STORE;
    return JSON.parse(raw) as MockTechStore;
  } catch {
    return DEFAULT_STORE;
  }
}

/** 写入 Mock 状态 */
export function saveMockStore(next: MockTechStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/** 打卡交互 (上班 / 下班 / 暂休 / 回岗) */
export function mockPunch(kind: 'clock_in' | 'clock_out' | 'break_start' | 'break_end'): MockTechStore {
  const store = getMockStore();
  if (kind === 'clock_in') {
    store.workbench.onDuty = true;
    store.workbench.onBreak = false;
    store.workbench.clockInTime = new Date().toTimeString().slice(0, 5);
  } else if (kind === 'clock_out') {
    store.workbench.onDuty = false;
    store.workbench.onBreak = false;
    store.workbench.currentTask = null;
  } else if (kind === 'break_start') {
    store.workbench.onBreak = true;
  } else if (kind === 'break_end') {
    store.workbench.onBreak = false;
  }
  saveMockStore(store);
  return store;
}

/** 开始做工服务 */
export function mockStartService(): MockTechStore {
  const store = getMockStore();
  if (store.workbench.currentTask) {
    store.workbench.currentTask.state = 'in_service';
    store.workbench.currentTask.startedAt = new Date().toISOString();
  }
  saveMockStore(store);
  return store;
}

/** 完工结算 */
export function mockFinishService(): MockTechStore {
  const store = getMockStore();
  const current = store.workbench.currentTask;
  if (current) {
    // 增加完工单量与记账流水
    store.workbench.doneCount += 1;
    const earnedCommission = 6500;
    const earnedTip = 3000;
    store.workbench.earnings.commissionCents += earnedCommission;
    store.workbench.earnings.tipCardCents += earnedTip;
    store.workbench.earnings.serviceRevenueCents += 15000;

    store.historyRecords.unshift({
      id: `rec_${Date.now()}`,
      ticketItemId: current.ticketItemId,
      serviceName: current.serviceName,
      customerName: current.customerName,
      durationMin: current.durationMin,
      timeStr: `${new Date(Date.now() - current.durationMin * 60000).toTimeString().slice(0, 5)} - ${new Date().toTimeString().slice(0, 5)}`,
      dateStr: new Date().toISOString().slice(0, 10),
      commissionCents: earnedCommission,
      tipCents: earnedTip,
      totalCents: 15000,
      isRequest: current.isRequest,
    });

    // 清除当前任务并进入就绪队列
    store.workbench.currentTask = null;
    store.workbench.rotation.consumedBp += 10000;
  }
  saveMockStore(store);
  return store;
}

/** 拒单顺延 */
export function mockDeclineTask(): MockTechStore {
  const store = getMockStore();
  store.workbench.currentTask = null;
  // 顺延至下一位
  store.workbench.rotation.position = 2;
  store.workbench.rotation.isNextUp = false;
  saveMockStore(store);
  return store;
}

/** 中途添加加项 */
export function mockAddAddon(addonId: string): MockTechStore {
  const store = getMockStore();
  const addon = store.addonCatalog.find((a) => a.id === addonId);
  if (addon && store.workbench.currentTask) {
    store.workbench.currentTask.addons.push(addon);
    store.workbench.currentTask.durationMin += addon.durationMin;
  }
  saveMockStore(store);
  return store;
}

/** 派发新测试任务 */
export function mockAssignNewTask(isWaiting: boolean = true): MockTechStore {
  const store = getMockStore();
  store.workbench.currentTask = {
    ticketId: `tkt_${Date.now()}`,
    ticketItemId: `item_${Date.now()}`,
    serviceName: 'Japanese Lash Extension 日式美睫定制嫁接',
    durationMin: 75,
    startedAt: isWaiting ? null : new Date().toISOString(),
    state: isWaiting ? 'waiting' : 'in_service',
    resourceName: '美睫工位 3',
    customerName: 'Chloe Bennett',
    customerPhone: '617-***-3941',
    isRequest: false,
    alerts: ['眼睛对快干胶水轻微敏感，请选用低敏专用温和黑胶。'],
    addons: [],
  };
  saveMockStore(store);
  return store;
}

/** 更新期望上下班时间 */
export function mockUpdateWorkHours(start: string, end: string): MockTechStore {
  const store = getMockStore();
  store.profile.expectedStart = start;
  store.profile.expectedEnd = end;
  saveMockStore(store);
  return store;
}
