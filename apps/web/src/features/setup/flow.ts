import {
  BellRing,
  CalendarRange,
  ClipboardCheck,
  Images,
  Scissors,
  Store,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type SetupStepId =
  | 'import'
  | 'store'
  | 'catalog'
  | 'team'
  | 'booking'
  | 'experience'
  | 'launch';

export interface SetupStep {
  id: SetupStepId;
  number: number;
  icon: LucideIcon;
  title: string;
  shortTitle: string;
  description: string;
  required: boolean;
}

/**
 * 开店向导只描述用户完成一家店所需的领域，不存“走到第几步”。
 * 真正进度后续应由门店、项目、员工等实际数据推导，避免跨设备出现假进度。
 */
export const SETUP_STEPS: SetupStep[] = [
  {
    id: 'import',
    number: 1,
    icon: Images,
    title: '导入现有店铺资料',
    shortTitle: '智能导入',
    description: '从 Google、Yelp、官网或价目表开始，所有结果先进入草案。',
    required: false,
  },
  {
    id: 'store',
    number: 2,
    icon: Store,
    title: '确认门店资料',
    shortTitle: '门店资料',
    description: '确认店名、地址、电话、时区、营业时间和节假日。',
    required: true,
  },
  {
    id: 'catalog',
    number: 3,
    icon: Scissors,
    title: '设置项目与价格',
    shortTitle: '项目价格',
    description: '核对项目分类、价格、时长、加项和在线预约状态。',
    required: true,
  },
  {
    id: 'team',
    number: 4,
    icon: UsersRound,
    title: '添加员工与排班',
    shortTitle: '员工日程',
    description: '添加可接单员工，分配项目、班表、房间和轮牌规则。',
    required: true,
  },
  {
    id: 'booking',
    number: 5,
    icon: CalendarRange,
    title: '预约与收款规则',
    shortTitle: '预约收款',
    description: '设置在线预约、取消订金、现金和已有线上收款方式。',
    required: true,
  },
  {
    id: 'experience',
    number: 6,
    icon: BellRing,
    title: '通知与品牌体验',
    shortTitle: '通知品牌',
    description: '配置顾客提醒、AI 电话、Logo、照片和公开预约主页。',
    required: false,
  },
  {
    id: 'launch',
    number: 7,
    icon: ClipboardCheck,
    title: '测试并正式开店',
    shortTitle: '测试开店',
    description: '模拟一次预约、签到和结账，通过检查后正式营业。',
    required: true,
  },
];

export const REQUIRED_SETUP_STEP_IDS = SETUP_STEPS
  .filter((step) => step.required)
  .map((step) => step.id);

